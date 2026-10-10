# Podcazt on AWS

Use one **t4g.small (2 vCPU, 2 GiB RAM), Ubuntu Server 24.04 LTS ARM64**
instance, a **20 GiB encrypted gp3** root volume, one Elastic IP, and private S3.
The host runs Nginx, Certbot, and Coturn. Docker Compose runs web, signaling,
PostgreSQL, and Redis. This is a small pilot deployment with one host.

All production files live in `deploy/aws`. Use this same directory for an Ubuntu
EC2 or Lightsail host; do not use `deploy/local` in production. Production
configuration stays in `/opt/podcazt/deploy/aws`, outside the source checkout.

[GitHub Actions CI/CD](#github-actions-cicd) builds images off the server and
deploys successful `main` commits automatically. The numbered steps below cover
initial provisioning and a manual first deployment.

## 1. Check the budget

Select **Asia Pacific (Mumbai), ap-south-1** throughout the AWS console.
In Billing, check your credit balance, eligible services, and expiry. Set monthly
budget alerts at $15 and $20; alerts do not stop spending.

AWS currently advertises a [t4g.small trial](https://aws.amazon.com/ec2/instance-types/t4/)
of 750 instance-hours per month through **December 31, 2026**. Confirm your
account's eligibility and any shared usage. This offer does not cover the full
five-month period starting October 2026. EBS, S3, snapshots, and outbound traffic
can still cost money. A public IPv4 address is
[$0.005/hour](https://aws.amazon.com/vpc/pricing/), about $3.65 per 730-hour month,
before applicable allowances or credits. Price the Mumbai instance and storage
in the [AWS calculator](https://calculator.aws/) before launch. TURN-relayed
video and recording downloads can make bandwidth the largest variable cost.

Use On-Demand capacity and Standard CPU credits for a predictable pilot. Standard
mode can throttle CPU when burst credits run out. Skip a NAT gateway, load
balancer, RDS, ElastiCache, and paid detailed monitoring for this setup.

## 2. Create the S3 bucket and EC2 role

1. In S3, create a general-purpose bucket in Mumbai with a unique name.
   Enable Block Public Access, disable ACLs, and use default SSE-S3 encryption.
   A production bucket separate from your local test bucket keeps their settings
   independent.
2. In IAM → Policies → Create policy → JSON, paste
   [`templates/s3-policy.json`](templates/s3-policy.json),
   replacing every `@@S3_BUCKET@@` with the exact bucket name. Name it
   `PodcaztBucketAccess`. This is an IAM identity policy, not a public bucket policy.
3. IAM → Roles → Create role → AWS service → EC2. Attach only that policy and
   name the role `PodcaztEc2Role`.

Use this role as the EC2 instance profile. The app and backup SDKs use
[automatically rotated EC2 credentials](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/loading-node-credentials-iam.html).
No AWS access keys are needed in production configuration.

## 3. Launch the instance

In EC2 → Instances → Launch instances:

| Setting | Value |
| --- | --- |
| Name | `podcazt` |
| AMI | Canonical Ubuntu Server 24.04 LTS, **64-bit Arm**, standard server image |
| Instance type | `t4g.small` |
| Key pair | Create/download a PEM SSH key and keep it private |
| Network | Default VPC, public subnet with `0.0.0.0/0` routed to an Internet Gateway |
| Public IPv4 | Enable initially; associate an Elastic IP in the next step |
| Root storage | 20 GiB gp3, encrypted; default IOPS/throughput |
| IAM instance profile | `PodcaztEc2Role` |
| Metadata | Endpoint enabled, **IMDSv2 required**, response hop limit **2** |
| Credit specification | **Standard** |

The [metadata hop limit](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-IMDS-new-instances.html)
must allow the Docker bridge hop so containers can obtain role credentials.
Do not choose an x86 AMI for a T4g instance. If you already chose `t3.small`,
use Ubuntu x86 and build `linux/amd64` instead of `linux/arm64` below.

Create a security group with these **inbound IPv4** rules:

| Protocol | Port | Source |
| --- | --- | --- |
| TCP | 22 | Your public administrator IP `/32` (console “My IP”) |
| TCP | 80 | `0.0.0.0/0` |
| TCP | 443 | `0.0.0.0/0` |
| TCP | 3478 | `0.0.0.0/0` |
| UDP | 3478 | `0.0.0.0/0` |
| TCP | 5349 | `0.0.0.0/0` |
| UDP | 49160–49259 | `0.0.0.0/0` |

Keep default outbound access. Leave custom network ACLs at their defaults for
this pilot. Do not publish 3000, 4000, 5432, or 6379. This guide uses IPv4 only.
The bootstrap also applies equivalent host firewall rules.

## 4. Allocate the Elastic IP and connect

EC2 → Network & Security → Elastic IPs → Allocate Elastic IP address → Actions
→ Associate Elastic IP address → select your instance and primary private IP.
Record the **Elastic IP** and the **private IPv4** from the instance details.
Use the Elastic IP for SSH, DNS, and Coturn's public mapping. Do not use your
Mac's `192.168.0.139` address for the server configuration.

On your Mac, replace the key path and `YOUR_EC2_IP` in all commands:

```bash
chmod 400 /path/to/podcazt.pem
ssh -i /path/to/podcazt.pem ubuntu@YOUR_EC2_IP
```

You can finish instance creation and image transfer before selecting your domain.
Domain-dependent configuration and Certbot must wait for valid public DNS.

## 5. Clone the source from GitHub

In the EC2 SSH terminal:

```bash
sudo apt-get update
sudo apt-get install -y git
git clone https://github.com/arisen37/podcazt.git "$HOME/podcazt"
cd "$HOME/podcazt"
```

If this checkout already exists, use `git pull --ff-only origin main` from that
directory instead. For a private repository, use a read-only deploy key and the
SSH clone URL `git@github.com:arisen37/podcazt.git`. Never embed a GitHub access
token in a clone URL or commit one. Keep the repository's existing visibility.

## 6. Bootstrap Ubuntu and build the image on EC2

Still in the source checkout:

```bash
sudo bash deploy/aws/bootstrap.sh
sudo install -d -m 0755 /opt/podcazt/deploy
sudo cp -R deploy/aws /opt/podcazt/deploy/

sudo docker build --platform linux/arm64 \
  --build-arg NODE_IMAGE=public.ecr.aws/docker/library/node:22-bookworm-slim \
  -t podcazt:latest .

cd /opt/podcazt/deploy/aws
sudo test -f config.env || sudo cp config.env.example config.env
sudo chmod 600 config.env
printf 'DOCKER_LIBRARY_PREFIX=public.ecr.aws/docker/library/\n' | sudo tee .env >/dev/null
```

The bootstrap installs Docker/Compose, Nginx, Certbot, Coturn, host firewall rules,
and a 1 GiB swap file. Run it before the build so the small instance has swap
headroom. The first build may take several minutes; it downloads dependencies
directly on EC2. Coturn stays disabled until configured with authentication and
certificates. The Node base image and Compose PostgreSQL/Redis images use Docker's
official ECR mirror, avoiding the Docker Hub authorization failure encountered
locally. Application secrets belong in `/opt/podcazt/deploy/aws/config.env`,
outside the Git checkout. Do not copy your local `.env`, local TLS private key,
or development database to EC2.

Only `.env.example` files, template configuration, and source are committed.
Actual env files, generated deployment config, credentials, TLS keys, build
artifacts, and database dumps are excluded from Git and the Docker build context.

## 7. Point your domain to EC2 and generate configuration

### Temporary deployment directly on the public IPv4

For an IP-only deployment, set these values in production `config.env`:

```dotenv
TLS_MODE=ip
APP_DOMAIN=YOUR_PUBLIC_IPV4
TURN_DOMAIN=YOUR_PUBLIC_IPV4
PUBLIC_IP=YOUR_PUBLIC_IPV4
PRIVATE_IP=YOUR_EC2_PRIVATE_IPV4
ACME_EMAIL=
```

Use the same actual public IPv4 for all three public-host values. An empty
email registers the Certbot account without email. Keep your other S3/auth
settings configured as described below. Open the same security-group ports.

```bash
sudo bash setup-config.sh --write
sudo bash install-ip-certbot.sh
sudo bash deploy.sh
sudo bash enable-tls.sh
sudo certbot renew --dry-run
```

The IP certificate requires Certbot >=5.4, installed in an isolated environment
by the installer; deployment rendering/tests still use TypeScript. The existing
systemd renewal timer is configured to use the updated client. Let's Encrypt's
[IP certificates](https://letsencrypt.org/2026/03/11/shorter-certs-certbot) expire
after about six days, so automatic renewal and its deploy hook are essential.
Use `https://YOUR_PUBLIC_IPV4` as the S3 CORS origin and app URL. Nginx serves
HTTPS on 443 and Coturn serves TURN TLS on 5349 with that IP certificate.

When adding DNS later, switch `TLS_MODE=domain`, set the two actual domains
and optionally ACME email, update DNS and S3 CORS, then regenerate configuration
and run `enable-tls.sh` followed by `deploy.sh`. Existing HTTPS stays available
while Certbot obtains the new certificate. Keep the IP stable until that transition.

### Domain deployment

At your domain's DNS provider, create these two **DNS-only A records**:

```text
studio.yourdomain.com → YOUR_EC2_ELASTIC_IP
turn.yourdomain.com   → YOUR_EC2_ELASTIC_IP
```

Use your own app subdomain or apex domain in place of `studio`. Disable HTTP
proxying for both names (Cloudflare: gray cloud). Remove conflicting AAAA
records for these names; if CAA records exist, permit `letsencrypt.org`.
Verify both A records point to the Elastic IP:

```bash
dig +short A studio.yourdomain.com
dig +short A turn.yourdomain.com
```

In the EC2 SSH terminal:

```bash
cd /opt/podcazt/deploy/aws
sudo nano config.env
```

Set these values, replacing the example IPs with your instance's addresses:

```dotenv
APP_DOMAIN=studio.yourdomain.com
TURN_DOMAIN=turn.yourdomain.com
ACME_EMAIL=you@yourdomain.com
PUBLIC_IP=YOUR_EC2_ELASTIC_IP
PRIVATE_IP=YOUR_EC2_PRIVATE_IPV4
AWS_REGION=ap-south-1
S3_BUCKET=YOUR_PRODUCTION_BUCKET
AWS_AUTH_MODE=instance-role
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_SESSION_TOKEN=
```

Leave PostgreSQL/session/internal/TURN secret values blank on the first setup;
the generator creates and saves them. Preserve them on subsequent deployments.
ACME_EMAIL may be empty to register with Certbot without an email address.
Email credentials are optional; Gmail requires an App Password.

```bash
sudo bash setup-config.sh --write
```

This writes private `runtime.env` and renders Nginx, Coturn, and S3 settings.
Never print `runtime.env` or run `docker compose config` without `--quiet`.

## 8. Configure S3 CORS and lifecycle

In S3 → your bucket → Permissions → CORS, paste the array inside `CORSRules`
from `/opt/podcazt/deploy/aws/generated/s3-cors.json`. It allows exactly
`https://studio.yourdomain.com` (using your configured domain).

In Management → Lifecycle rules, configure the rules from
`generated/s3-lifecycle.json`: abort incomplete uploads under `recordings/`
after 7 days; expire objects under `backups/` after 14 days. Completed recordings
remain until you deliberately delete them.

Alternatively, copy those two non-secret JSON files to your Mac and run in an
administrator-authenticated AWS CLI session:

```bash
aws s3api put-bucket-cors --bucket YOUR_PRODUCTION_BUCKET --cors-configuration file://s3-cors.json
aws s3api put-bucket-lifecycle-configuration --bucket YOUR_PRODUCTION_BUCKET --lifecycle-configuration file://s3-lifecycle.json
```

These commands replace existing bucket CORS/lifecycle configurations. Merge
rules first if using an existing bucket. The instance's app role intentionally
cannot change bucket configuration.

## 9. Initialize the database and issue certificates

On EC2:

```bash
cd /opt/podcazt/deploy/aws
sudo bash deploy.sh
sudo bash enable-tls.sh
sudo certbot renew --dry-run
```

`deploy.sh` starts PostgreSQL/Redis, applies migrations to the new database, and
starts web/signaling. It does not import your local accounts or recordings.
`enable-tls.sh` uses **Certbot** to obtain a public certificate for both domains,
enables Nginx HTTPS/WSS, and starts authenticated Coturn. Keep port 80 open for
renewals. Do not reuse mkcert certificates on AWS. Coturn certificate renewal
restarts that service and briefly interrupts relayed calls.

## 10. Verify the deployment

```bash
cd /opt/podcazt/deploy/aws
sudo docker compose config --quiet
sudo docker compose ps
sudo nginx -t
sudo systemctl is-active coturn
curl --fail https://studio.yourdomain.com/api/health
sudo docker compose exec -T web node --input-type=module -e 'import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3"; await new S3Client({region:process.env.AWS_REGION}).send(new ListObjectsV2Command({Bucket:process.env.S3_BUCKET,Prefix:"recordings/",MaxKeys:1})); console.log("S3 role access OK");'
```

The last command verifies S3 access through the instance role without printing
credentials or recording names. If it cannot obtain credentials, check that the
role is attached, IMDS is enabled/V2 required, response hop limit is 2, and
`runtime.env` contains no static credential overrides.

Open **https://studio.yourdomain.com** (port 443, no `:8443`). Test signup, a
recording upload and playback, and a call with two users on different networks.
Verify a relay-only call, not just a direct call or TURN TLS handshake. Nginx
owns TCP 443; TURN TLS uses TCP 5349, which some restrictive networks may block.
See [the local test guide](../local/README.md#7-test-calls-and-reconnects) for the
relay-allocation probe; a full media-path test still needs two peers.

## 11. Enable database backups

```bash
cd /opt/podcazt/deploy/aws
sudo install -m 0644 podcazt-backup.service podcazt-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now podcazt-backup.timer
sudo systemctl start podcazt-backup.service
sudo journalctl -u podcazt-backup.service --no-pager
```

Confirm a new object under `backups/` in S3 and test a restore before relying on
the backup. PostgreSQL data lives in the Docker volume on EBS; never use
`docker compose down -v` on the deployed database. Preserve `config.env` and the
database volume during updates.

For source-based updates, first back up and then build from the new commit:

```bash
sudo systemctl start podcazt-backup.service
cd "$HOME/podcazt"
git pull --ff-only origin main
sudo docker build --platform linux/arm64 \
  --build-arg NODE_IMAGE=public.ecr.aws/docker/library/node:22-bookworm-slim \
  -t podcazt:latest .
sudo cp -R deploy/aws /opt/podcazt/deploy/
cd /opt/podcazt/deploy/aws
sudo bash setup-config.sh --write
sudo bash deploy.sh
```

Builds compete with the running services for the instance's 2 GiB of RAM. If
memory pressure affects calls, schedule an update window and stop web/signaling
before building; `deploy.sh` starts them again. The previous image and running
containers remain available if the build itself fails. The GitHub Actions pipeline below moves image builds off EC2.

Stopping EC2 pauses instance compute charges, but attached EBS and allocated
Elastic IPs still cost money, and the app/calls are unavailable while stopped.
Terminating can delete the root volume and its database, depending on its
Delete-on-termination setting. An EC2 instance role is associated with the
instance; include role attachment and metadata options when recreating it.

The scripts and TypeScript configuration tests have been checked locally; this
guide does not claim that resources have already been created or tested in your
AWS account.

## GitHub Actions CI/CD

The workflow in [`.github/workflows/ci-cd.yml`](../../.github/workflows/ci-cd.yml)
runs lint, tests, and a production build for pull requests and pushes to `main`.
Successful `main` runs publish an ARM64 image to `ghcr.io/arisen37/podcazt`, smoke
test it, and deploy that exact digest over SSH. Dependency layers use the GitHub
Actions build cache. EC2 pulls the image instead of running `npm ci` or a build.

The deployment checks that the commit is still `origin/main`, backs up PostgreSQL
to S3, applies migrations, waits for web/signaling health checks, and checks the
public HTTPS health and favicon routes. An application failure restores the
previous image. Database migrations are not reversed; use migrations compatible
with the previous application version. Container replacement briefly interrupts
calls, so deploy outside active recording sessions.

One-time setup for a provisioned host:

1. Generate a dedicated key on a trusted machine:

   ```bash
   ssh-keygen -t ed25519 -N '' -C podcazt-github-actions -f /tmp/podcazt-actions
   scp -i /path/to/podcazt.pem /tmp/podcazt-actions.pub ubuntu@YOUR_EC2_IP:/tmp/
   ```

2. On EC2, from the source checkout, install the restricted key:

   ```bash
   sudo bash deploy/aws/install-github-deploy.sh /tmp/podcazt-actions.pub
   ```

   This moves an existing `/opt/podcazt/deploy/lightsail` directory to `aws` and
   leaves a compatibility symlink for existing certificate hooks. The key can
   only invoke deployment commands; SSH forwarding and interactive sessions are
   disabled. The original administrator key remains separate.

3. In GitHub → repository Settings → Secrets and variables → Actions, add:

   | Type | Name | Value |
   | --- | --- | --- |
   | Secret | `EC2_DEPLOY_KEY` | Contents of the dedicated private key |
   | Variable | `EC2_HOST` | Stable EC2 public IPv4 |
   | Variable | `EC2_USER` | `ubuntu` |
   | Variable | `EC2_KNOWN_HOSTS` | Trusted SSH host-key line for that IP |

   Verify the host key through your existing trusted SSH connection; do not
   automatically trust a new `ssh-keyscan` result in the workflow. Create a
   `production` environment restricted to `main`, with no required reviewers if
   automatic deployment is desired. Remove the temporary private key after
   saving it securely in GitHub. No AWS access keys are required in Actions.

4. Allow the GitHub runner to reach SSH in the EC2 security group/firewall. The
   administrator-only `/32` rule in the provisioning steps alone will not allow
   hosted runners. Choose an access policy for your network, or use a runner with
   a stable IP. The workflow checks SSH access before building/publishing.

5. Push to `main`, or use Actions → CI and EC2 deployment → Run workflow on
   `main`. Watch the checks, image, and deploy jobs. The server records the active
   commit/digest in `/opt/podcazt/deploy/aws/github-release.txt` and retains
   `podcazt:rollback`. After health checks, `cleanup-images.sh` removes older
   application GHCR digests, retaining both tagged images and any image used by
   the web/signaling containers. It never prunes database images or volumes.

Application secrets stay in `config.env`/`runtime.env` on EC2. The short-lived
workflow token is used to pull from GHCR and its temporary Docker login is
removed after deployment. Changes to Compose, Nginx, Coturn, certificates, or
runtime environment settings still require an explicit host configuration update.

For Lightsail, use the same directory and scripts with an Ubuntu instance, a
static public IP, and equivalent firewall ports. Set `AWS_AUTH_MODE=static` with
restricted bucket credentials when an EC2 instance role is unavailable. Choose
the image architecture matching your host; the included workflow targets the
current ARM64 EC2 server.

### Deployment fails with `no space left on device`

This error during layer extraction means EC2 storage is full. The Docker login
warning about unencrypted credentials does not cause it; the temporary login
directory is removed when deployment exits. Changing the EC2 instance type does
not increase its EBS volume.

Use a root volume of at least 20 GiB for this deployment, and leave at least
2 GiB free before a release that changes dependencies. Docker's containerd image
store can retain both compressed and extracted layers. The 512 MiB preflight
floor checks deployment and Docker storage before building and again before
pulling; it is a minimum, not a guarantee that a large new image will fit.

Inspect storage through the administrator SSH key:

```bash
df -h / /var/lib/docker /var/lib/containerd
sudo docker system df
sudo docker image ls --digests
```

If the host still holds unused cache from older builds, reclaim it with
`sudo docker builder prune --all --force`. Builds now run on GitHub, so EC2 does
not need that build cache. To retire superseded application digests after a
successful release, run
`sudo bash /opt/podcazt/deploy/aws/cleanup-images.sh`. Missing protected images
make that script stop without deleting images. Avoid `docker system prune -a`
and volume pruning: preserve the rollback image and production data.

If free space remains low, expand the EBS volume, partition, and filesystem;
then verify `df -h` shows the increased capacity. Retry the failed jobs in GitHub
Actions after recovering space. Storage cleanup alone cannot make an 8 GiB
volume reliably accommodate growing application images and database data.

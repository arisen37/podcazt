# Podcazt on AWS Lightsail

Target: **Ubuntu 24.04 LTS, $12/month Linux IPv4 bundle, 2 GB RAM**, Mumbai
(`ap-south-1`). One host runs Nginx, Certbot, Coturn, and Docker Compose services
for Next.js, signaling, PostgreSQL 16, and Redis 7. Recordings live in private S3.

Budget for light pilot usage: approximately $15–18/month including modest S3
storage and snapshots. Traffic, storage growth, taxes, and domain registration
are additional variables. Mumbai has 1.5 TB/month included transfer on this
bundle. Stopping Lightsail does not stop its instance charges. Check credit
eligibility and expiration in Billing; do not assume historical free-tier offers.

## 1. Create the instance and static IP

In Lightsail, select Mumbai, Linux/Unix, **OS only → Ubuntu 24.04 LTS**, and the
$12 IPv4 bundle. Attach a Lightsail static IPv4 address. Note both the public
static IP and the private IPv4 address from the Networking page.

Configure the Lightsail IPv4 firewall:

| Port | Protocol | Source |
| --- | --- | --- |
| 22 | TCP | Your administrator IP only |
| 80, 443 | TCP | All IPv4 |
| 3478 | TCP and UDP | All IPv4 |
| 5349 | TCP | All IPv4 |
| 49160–49259 | UDP | All IPv4 |

Do not expose ports 3000, 4000, 5432, or 6379. Do not add AAAA records or open
IPv6 traffic for this IPv4 deployment. Coturn uses 5349 for TLS because Nginx
owns 443; networks that only permit TCP 443 may still block relay connections.
Supporting TURN TLS on 443 later needs a separate IP/instance or a deliberately
configured TLS multiplexer.

## 2. Build the Linux image on your computer

Install Docker with Buildx locally. Run from the repository root:

```bash
npm ci
npm run lint
npm run typecheck
npm run test:reliability
docker buildx build --platform linux/amd64 --load -t podcazt:latest .
docker save podcazt:latest | gzip > /tmp/podcazt-image.tar.gz
scp -i /path/to/lightsail-key.pem /tmp/podcazt-image.tar.gz ubuntu@YOUR_STATIC_IP:/tmp/
scp -i /path/to/lightsail-key.pem -r deploy ubuntu@YOUR_STATIC_IP:/tmp/podcazt-deploy
```

Build on your computer, including on Apple Silicon using `--platform
linux/amd64`. Do not copy a macOS `.next` directory or Prisma engine onto Linux.
The Docker build excludes `.env`, credentials, generated configuration, and
local build artifacts. Keep production secrets out of Docker build arguments.
The browser derives the WebSocket URL from its current host, so a domain change
does not require rebuilding the image.

## 3. Bootstrap the host and load the image

SSH into the instance:

```bash
sudo mkdir -p /opt/podcazt
sudo cp -R /tmp/podcazt-deploy /opt/podcazt/deploy
cd /opt/podcazt/deploy/lightsail
sudo bash bootstrap.sh
sudo docker load -i /tmp/podcazt-image.tar.gz
sudo cp config.env.example config.env
sudo chmod 600 config.env
```

You can complete these steps before choosing the domain. The bootstrap installs
Docker, Nginx, Certbot, Coturn, a 1 GB swap file, and host firewall rules. It keeps
Coturn disabled until authentication and certificates have been configured.
This is a dedicated-host installer: review it before using it on a machine that
already hosts other applications.

## 4. Connect the custom domain

At your existing DNS provider, add two **DNS-only A records**:

```text
studio.yourdomain.com  → YOUR_STATIC_IP
turn.yourdomain.com    → YOUR_STATIC_IP
```

The main domain or any subdomain can replace `studio.yourdomain.com`. Keep TURN
on a separate subdomain. Do not enable a DNS provider's HTTP proxy for TURN;
use DNS-only for both names with these configs. If the domain has CAA records,
allow `letsencrypt.org`. Confirm both names resolve publicly to the static IP.

Trusted certificates and full camera/microphone testing require this step.
The installation deliberately does not expose the application over plain HTTP.

## 5. Create private S3 storage and restricted credentials

Create an S3 general-purpose bucket in Mumbai, with **Block Public Access on**,
ACLs disabled, and default SSE-S3 encryption. Keep recordings private.

Create an IAM user with no console access and a bucket-scoped IAM policy based
on `templates/s3-policy.json`; replace `@@S3_BUCKET@@` with your bucket name.
This JSON is an **IAM identity policy**, not a public bucket policy. Create an
access key for the app. Lightsail instances do not provide EC2 instance-profile
credentials, so these credentials must be supplied explicitly and kept private.

Edit the server config:

```bash
sudo nano /opt/podcazt/deploy/lightsail/config.env
sudo bash /opt/podcazt/deploy/lightsail/setup-config.sh --write
```

Set the two domains, public/private IPs, bucket name, AWS region and restricted
access key. ACME_EMAIL is optional; leave it empty to register without email.
Gmail credentials are
optional; without them invites work in the app but invitation email is skipped.
Use a Gmail App Password, not the account password.

The generator persists random PostgreSQL/session/internal/TURN secrets in
`config.env`, writes `runtime.env`, and renders deployment templates. Reruns
preserve these secrets. Never commit or paste either env file into logs. Avoid
`docker compose config` without `--quiet`, because it displays secrets.

Using an administrator AWS CLI session, apply the generated S3 settings (or
enter equivalent rules in the console):

```bash
aws s3api put-bucket-cors --bucket YOUR_BUCKET --cors-configuration file://generated/s3-cors.json
aws s3api put-bucket-lifecycle-configuration --bucket YOUR_BUCKET --lifecycle-configuration file://generated/s3-lifecycle.json
```

The JSON files are safe to copy to your computer for these commands. The
application IAM user cannot change bucket settings. Console CORS expects the
array inside `CORSRules`, rather than the enclosing AWS CLI object.
Lifecycle rules abort unfinished multipart uploads after seven days and expire
database backups after fourteen days. They **do not delete completed recordings**.

## 6. Initialize the fresh database and start services

```bash
cd /opt/podcazt/deploy/lightsail
sudo bash deploy.sh
```

The script applies the versioned Prisma baseline migration before starting the
app. Existing Supabase data is not copied automatically; export and plan its
import separately before moving an existing production database. An existing
database whose schema already matches needs the baseline marked applied using
`prisma migrate resolve --applied 20261010000000_initial` after verifying the
schema; do not run the baseline CREATE statements against populated tables.
Future schema changes need a reviewed migration and a backup before deployment.

Containers restart after reboot and have memory/log limits. PostgreSQL persists
in a named Docker volume. Redis is disposable and restricted to Docker's private
network. Both application services use the same production image. There is no
NAT gateway, RDS, ElastiCache, load balancer, or separate Lambda bill.

## 7. Issue certificates using Certbot

After DNS propagation and after opening port 80:

```bash
cd /opt/podcazt/deploy/lightsail
sudo bash enable-tls.sh
sudo certbot renew --dry-run
sudo systemctl list-timers certbot.timer
```

Certbot uses the webroot HTTP challenge and issues one certificate covering both
domains. Nginx terminates HTTPS and proxies `/ws` to signaling. The deploy hook
copies the certificate/key to a restricted directory for Coturn, reloads Nginx,
and restarts Coturn after successful renewal. **The Coturn restart briefly
interrupts relayed calls.** Port 80 must stay open for future renewals.

Do not hand-copy certificates or weaken permissions on `/etc/letsencrypt`.
If the domain later changes, update `config.env`, regenerate config, update S3
CORS/DNS, rerun `enable-tls.sh`, and run `deploy.sh`. Remove obsolete Certbot
lineages deliberately after confirming the new domain works.

## 8. Enable backups and budget alerts

```bash
cd /opt/podcazt/deploy/lightsail
sudo install -m 0644 podcazt-backup.service podcazt-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now podcazt-backup.timer
sudo systemctl start podcazt-backup.service
sudo journalctl -u podcazt-backup.service --no-pager
```

The job streams a consistent PostgreSQL dump to a temporary compressed file,
uploads it to private S3, then removes the local file. S3 retains fourteen days.
Also enable Lightsail snapshots with limited retention. A snapshot is useful for
host recovery; the database dump is the database restore path. Test a restore.

To restore a dump **into a new empty database**, before initializing its schema:

```bash
gzip -dc postgres-BACKUP_TIMESTAMP.sql.gz | sudo docker compose exec -T postgres psql -U podcazt -d podcazt -v ON_ERROR_STOP=1
```

Set AWS monthly budget alerts at $15 and $18, track credit expiry, and inspect
Lightsail transfer/S3 storage. Budget alerts do not enforce a spending cap.

## 9. Verify before inviting users

```bash
sudo docker compose config --quiet
sudo docker compose ps
sudo nginx -t
curl --fail https://studio.yourdomain.com/api/health
openssl s_client -connect turn.yourdomain.com:5349 -servername turn.yourdomain.com </dev/null
```

Create two test accounts and join a room from different networks. Verify
camera, microphone, invitations, and WebSocket reconnect after briefly dropping
the network. Use browser WebRTC diagnostics to confirm a relay candidate works;
a successful TLS handshake alone does not prove TURN relay works. Test a
relay-only connection in browser diagnostics or a dedicated WebRTC test client.

Record enough footage to produce multiple 8 MiB parts. In DevTools, confirm PUTs
go directly to S3, at most three parts are in flight, and checksums are sent.
Disconnect during upload, reconnect, and Retry; verify acknowledged parts are
reused and the final video plays. Refresh during a failed upload and return to
the same open room; the local recording should be available to retry. Verify
unauthenticated users and another account cannot open recording/preview URLs.

## Reliability behavior and limits

Recording uploads use a three-part sliding window, selective retries (five
attempts with backoff), SHA-256 validation per part by S3, persistent upload
sessions in IndexedDB, server-side reconciliation of S3 part numbers/checksums/
sizes, and idempotent completion recovery. Parts are 8 MiB; maximum recording
size is 5 GiB. Failed attempts keep local recording chunks. A manually retried
expired session starts a fresh upload from retained local data. S3 stores a
composite multipart checksum; `videos.sha256` is null for this path rather than
mislabeling it as the full-file SHA-256 used by the legacy Supabase path.

SDP offers, answers, and ICE candidates use an eight-message window on each
signaling hop, acknowledgements, bounded retransmission, serialized handling,
and duplicate suppression. A socket reconnect creates fresh peers and fresh
negotiation rather than replaying stale messages. The pilot routes signaling
locally (`SINGLE_INSTANCE_SIGNALING=true`) and uses Redis for notifications/rate
limits. Do not scale this single-instance mode to multiple signaling servers.

WebRTC's negotiated RTP feedback/retransmission, jitter buffering, congestion
control, and keyframe recovery remain responsible for live media. Automatic ICE
restart attempts to repair failed paths. Live media is not wrapped in a custom
reliable byte stream: retransmitting obsolete frames indefinitely would break
real-time latency. Neither recordings nor live calls have an unconditional 100%
delivery guarantee during permanent failure, browser-storage loss, power loss,
or loss of the host. Browser recording is the owner's composite view, so remote
frames already lost during a call cannot be reconstructed by reliable upload.

## Updating the app

Build and transfer a new `podcazt:latest` image as in step 2, load it, then:

```bash
cd /opt/podcazt/deploy/lightsail
sudo systemctl start podcazt-backup.service
sudo bash deploy.sh
```

Do not overwrite `config.env`, rotate the PostgreSQL password by editing the env
file alone, run `docker compose down -v`, or delete the database volume. Preserve
the previous image tag for rollback. Updates restart services and interrupt calls;
schedule them when no sessions are active. Live upgrades are not zero-downtime.

References: [AWS Lightsail bundles](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-bundles.html),
[Certbot renewal hooks](https://eff-certbot.readthedocs.io/en/stable/using.html),
[Nginx WebSocket proxying](https://nginx.org/en/docs/http/websocket.html),
[S3 multipart upload limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html),
[Coturn configuration](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf).

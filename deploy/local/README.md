# Local Docker testing (macOS)

This runs the production app image, PostgreSQL, Redis, signaling, Nginx, and
Coturn on your computer. Recording storage uses a **real private S3 test bucket**;
uploads and storage therefore consume a small amount of AWS credit. This setup
does not create a Lightsail instance. The local database has its own volume and
does not use or overwrite the Lightsail configuration.

## 1. Install prerequisites

Install and start Docker Desktop. Allow at least 4 GB Docker memory for builds.
Verify Compose is available:

```bash
docker version
docker compose version
```

Install [mkcert](https://github.com/FiloSottile/mkcert) for a trusted local
certificate (Certbot remains the public-domain certificate tool on Lightsail):

```bash
brew install mkcert
mkcert -install
```

If using Firefox, install `nss` before running `mkcert -install`. Restart your
browser after installing the local CA. Do not share mkcert's root CA private key.

## 2. Configure the local hostname and environment

From the repository root:

```bash
cp deploy/local/.env.example deploy/local/.env
cd deploy/local
```

Using `sudo nano /etc/hosts`, add this line once:

```text
127.0.0.1 podcazt.test
```

Find your computer's LAN IPv4 address in System Settings → Network. For typical
Wi-Fi Macs, `ipconfig getifaddr en0` also prints it. Edit `.env` and set:

- `LOCAL_TURN_IP` to that LAN IPv4 (for example `192.168.1.25`). Coturn must
  advertise a host address reachable from browsers and its Docker container;
  neither `127.0.0.1` nor the Docker container address works as this mapping.
- `S3_BUCKET`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY` for your private
  test bucket. Use `AWS_SESSION_TOKEN` as well if these are temporary credentials.
- Replace the three example `*_SECRET` values with random strings. Run
  `openssl rand -hex 32` separately for each secret. Use local secrets rather than
  copying production secrets. Keep `TURN_HOST=${LOCAL_TURN_IP}` as written.

PostgreSQL's local password and `DATABASE_URL` already match. If you change one,
change the other **before creating the database volume**. Gmail is optional;
leave it empty to test in-app invitations without sending emails.

The `.env` and certificate directory are excluded from Git and Docker builds.
Avoid printing the full Compose config; use `docker compose config --quiet`.

## 3. Generate the local TLS certificate

Still in `deploy/local`, substitute your actual LAN IPv4 in the command below:

```bash
mkdir -p certs
mkcert -cert-file certs/cert.pem -key-file certs/key.pem podcazt.test localhost 127.0.0.1 192.168.1.25
```

Nginx uses the certificate for `podcazt.test`; Coturn uses the IP SAN for its TLS
listener. Regenerate the certificate and update `.env` if your LAN IP changes.
Certbot cannot validate this local-only test name through public DNS. Do not run
the Lightsail bootstrap or Certbot scripts on your Mac.

If `mkcert -install` prompts for an administrator password, complete it in your
own terminal. Creating certificate files alone does not install browser trust.
An Nginx `cannot load certificate ... No such file or directory` error means
the two files above have not been generated at the mounted `certs` path.

## 4. Configure S3 for local uploads

Use a separate bucket in Mumbai (`ap-south-1`), with Block Public Access enabled
and default SSE-S3 encryption. Configure the app IAM user using the bucket-scoped
policy described in [the deployment guide](../lightsail/README.md#5-create-private-s3-storage-and-restricted-credentials).

In an authenticated AWS CLI session (the CLI does not automatically load this
app's `.env`), run from `deploy/local`:

```bash
aws s3api put-bucket-cors --bucket YOUR_TEST_BUCKET --cors-configuration file://s3-cors.json
```

If using the AWS console instead, paste the array inside `CORSRules` from
`s3-cors.json`. The allowed origin must be exactly `https://podcazt.test:8443`.
Use this local-only CORS rule on the **test bucket**, because it replaces that
bucket's existing CORS configuration. Also enable an S3 lifecycle rule to abort
incomplete multipart uploads after seven days.

## 5. Build and initialize

Still in `deploy/local`:

```bash
docker compose config --quiet
docker compose build web
docker compose up -d --wait postgres redis
docker compose run --rm --no-deps web node node_modules/prisma/build/index.js migrate deploy
docker compose up -d --wait
docker compose ps
```

The local image builds for your Mac's architecture. Use the Lightsail guide's
`linux/amd64` build separately when preparing the AWS image. PostgreSQL and Redis
have no published host ports. Coturn publishes 3478, 5349, and UDP 49160–49259 to
the host so relay allocations can reach it; keep this test instance on a trusted
local network. These local settings allow private-network media peers and are
not a replacement for the production Coturn configuration.

## 6. Check HTTPS, database, Redis, and signaling

```bash
curl --cacert "$(mkcert -CAROOT)/rootCA.pem" https://podcazt.test:8443/api/health
docker compose exec nginx nginx -t
docker compose exec postgres pg_isready -U podcazt -d podcazt
docker compose exec redis redis-cli ping
docker compose exec signaling node -e "fetch('http://127.0.0.1:4000/health').then(r=>r.json()).then(console.log)"
```

Expect an `ok: true` health response, successful Nginx/DB checks, and Redis
`PONG`. Open **https://podcazt.test:8443**. The browser should show a trusted
connection, and sign-up/sign-in should work with secure cookies.

### Access through your LAN IP

By default HTTPS binds to `127.0.0.1`. To use your computer's LAN IP or test from
another device, set `LOCAL_HTTPS_BIND_IP=0.0.0.0` in `.env`, then run:

```bash
docker compose up -d --force-recreate nginx
```

Open `https://YOUR_LAN_IP:8443` with **HTTPS**. The certificate from step 3 must
include that IP, and each device/browser needs to trust the mkcert root CA
certificate (`rootCA.pem`, never `rootCA-key.pem`). The other device must be on
a network that can reach your Mac and its firewall must allow the connection.
If you upload recordings from the IP URL, add its exact origin (for example
`https://192.168.0.139:8443`) to the S3 test bucket's allowed CORS origins. For
invitation links using that URL, also set `NEXT_PUBLIC_APP_URL` to the IP origin
and recreate `web`. Using `podcazt.test` requires that name to resolve to your
Mac's LAN IP on the other device.

## 7. Test calls and reconnects

1. Create an owner account in a normal browser window.
2. Create a participant account in an incognito window or a separate browser.
3. As owner, create a podcast room and invite the participant's email.
4. Accept the invite in the participant window. Allow camera/microphone access
   in both windows; use headphones to avoid feedback.
5. Verify both participant tiles, microphone/camera controls, and owner-only
   recording controls. In DevTools → Network → WS, confirm `/ws` upgraded with
   HTTP 101, and offer/answer/ICE messages have corresponding `signal-ack` messages.
6. Restart signaling with `docker compose restart signaling`. Both clients should
   reconnect and negotiate fresh peer connections while keeping camera access.

Inspect `chrome://webrtc-internals` (Chrome) or `about:webrtc` (Firefox) to see
candidate paths, packet loss, and retransmission statistics. Direct local calls
may use host candidates and never need TURN. To check relay allocation, in a
signed-in studio's DevTools Console run:

```javascript
const { iceServers } = await fetch('/api/turn-credentials').then(r => r.json());
const relayProbe = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'relay' });
relayProbe.createDataChannel('relay-probe');
relayProbe.onicecandidate = ({ candidate }) => {
  if (candidate) console.log(candidate.type, candidate.address, candidate.port);
};
await relayProbe.setLocalDescription(await relayProbe.createOffer());
// After inspecting candidates, release the allocation:
// relayProbe.close();
```

Expect a `relay` candidate advertising your LAN IP. Check `docker compose logs
coturn` if none appears. Docker Desktop/VPN routing and the Mac firewall can
affect UDP; allow Docker on the local network and confirm the LAN IP is current.
This probe verifies allocation, not a complete two-peer relay path. Public TURN
reachability and calls across different networks still require testing on AWS.

## 8. Test uploads, retries, and access control

1. Record a solo or podcast session long enough to exceed 8 MiB, then stop.
2. In DevTools → Network, verify `PUT` requests go directly to the S3 test bucket,
   with `x-amz-checksum-sha256`, rather than proxying video bytes through Nginx.
   No more than three parts should upload concurrently. A short recording may
   have only one part.
3. Use DevTools Offline mode during upload, then restore Online. Automatic
   retries should recover transient failures. If retries exhaust, click Retry.
4. Stop a recording, interrupt its upload, and refresh the room. The persisted
   recording should be available to retry, and acknowledged S3 parts should be
   reused. Do not close the room before this recovery test.
5. Verify the completed video and preview appear on the dashboard and play.
6. Open the owner's `/api/media/<video-id>` URL in the participant window and
   while signed out. It should return 404/401 respectively. Copy the app URL,
   not an already-issued temporary S3 URL, which remains usable until expiry.

## 9. Run the TypeScript tests

From the repository root:

```bash
npm ci
npm test
npm run lint
npm run typecheck
```

`npm test` runs both reliability tests and deployment-config tests using Node and
tsx. No Python is required. Alternatively run `npm run test:deployment-config`.

## Logs, updates, and shutdown

If pulls fail with a Docker Hub `auth.docker.io/token` HTTP 500, add these
settings to `deploy/local/.env`:

```dotenv
DOCKER_LIBRARY_PREFIX=public.ecr.aws/docker/library/
COTURN_IMAGE=ghcr.io/coturn/coturn:latest
```

These use [Docker's official images on Amazon ECR Public](https://www.docker.com/blog/news-from-aws-reinvent-docker-official-images-on-amazon-ecr-public/)
and [Coturn's own GitHub registry](https://github.com/coturn/coturn/blob/master/docker/coturn/README.md).
Then repeat the build and initialization commands in step 5. The app image
must be built before `up --force-recreate`; recreating containers does not
build a missing `podcazt:local` image. Remove these settings to use Docker Hub
again. This changes local image sources only.

The local Coturn command uses the current image defaults for disabled CLI and
DTLS listeners. Coturn 4.18 rejects the removed `--no-dtls` option; do not add
it to this command. The Ubuntu package used on Lightsail has its own host
configuration.

From `deploy/local`:

```bash
docker compose logs --tail=100 web signaling nginx coturn
docker compose up -d --build --force-recreate web signaling nginx
docker compose down
```

`down` keeps the local database volume. A deliberate `docker compose down -v`
deletes the local database; use it only when you want to reset test accounts and
recording metadata. S3 recordings remain until separately removed from the test
bucket. The local image build, database migration, PostgreSQL/Redis health,
and web/signaling health endpoints have been verified with Docker Desktop on
macOS. Nginx configuration and HTTPS using the generated CA have also passed,
and Coturn starts with its certificate and relay listeners. Browser trust, S3
uploads, and TURN media behavior still require the end-to-end checks above.

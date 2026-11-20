# Docker sandbox images

Both Dockerfiles require an immutable parent image (`name@sha256:...`). Tags alone are intentionally unsupported by the runtime.

```powershell
docker build --build-arg BASE_IMAGE=node:24-bookworm-slim@sha256:<digest> -t dmw-sandbox:local docker/sandbox
docker image inspect --format '{{.Id}}' dmw-sandbox:local
```

Configure the printed `sha256:...` image ID, not the mutable local tag. The browser image is separate so normal build/test jobs do not carry Chromium:

```powershell
docker build -f docker/sandbox/Dockerfile.browser --build-arg SANDBOX_IMAGE=sha256:<sandbox-image-id> -t dmw-sandbox-browser:local docker/sandbox
```

The runtime mounts only the authorized task copy at `/workspace` and one explicitly named package-cache volume at `/cache`. It defaults to no network. Enabling install networking still permits it only for `purpose: "install"` and a package-manager executable. Package install scripts execute third-party code, so use a dedicated image/cache and review lockfiles.

Choose a cache volume with a `dmw-` prefix. The runtime creates it with the workbench ownership label and checks that label on subsequent runs. The default image initializes writable cache directories for UID/GID 10001. Docker execution is limited to a local Unix socket or Windows named pipe.

Sol executes commands in a credential-filtered copy. Successful non-test commands can synchronize additions and edits into the authorized main workspace through the existing integration journal. Test and review commands leave their changes in their copy. The `local-unsafe` backend records direct-process exit and supplies no independent acceptance evidence.

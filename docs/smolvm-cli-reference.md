# smolvm CLI Reference (captured verbatim from installed binary)

- **Captured:** 2026-09-22, from `smolvm 1.17.0` (linux-x86_64)
- **Binary path:** `/home/genegulanesjr/.local/bin/smolvm` → symlink to `/home/genegulanesjr/.smolvm/smolvm`
- **Installer:** `curl -sSL https://smolmachines.com/install.sh | bash` (user-level; placed binary under `~/.smolvm/`, symlinked into `~/.local/bin/`). Installer upgraded a pre-existing 0.5.20 → 1.17.0.
- **KVM:** `/dev/kvm` writable, confirmed. Hypervisor: KVM (per `smolvm --help` platform table).
- **Purpose:** source of truth for the Task 8 `smolvm` adapter. All help text below is VERBATIM command output, not paraphrased.

---

## FLAG MAP

Answers distilled from the verbatim help output below. Exact flag strings as observed.

| Question | Answer (exact syntax) |
|---|---|
| Volume mount flag | `-v, --volume <HOST\|REMOTE:GUEST[:ro\|rw\|staged]>` — repeatable ("can be used multiple times"). Value syntax `host:guest`, optional suffix `:ro`, `:rw`, or `:staged` (staged = guest-local copy, synced back on `machine sync`/graceful stop). Also accepts S3 remotes: `s3://bucket/prefix:/data[:ro]` |
| Egress allow flag | `--allow-host <HOSTNAME>` — repeatable; "resolved at VM start"; **implies `--net`**. Companion: `--allow-cidr <CIDR>` (repeatable, implies `--net`), `--outbound-localhost-only` (implies `--net`), `--allow-host-loopback` (implies `--net`, off by default) |
| SSH agent flag | `--ssh-agent` — "Forward host SSH agent into the VM (enables git/ssh without exposing keys)". Present on `machine create` and `machine run` |
| Memory flag | `--mem <MiB>` — **unit is MiB**, default 8192. Elastic: only touched memory is committed |
| CPU flag | `--cpus <N>` — default 4. A consumption cap, not a reservation |
| Image flag | `-I, --image <IMAGE>` — **capital `-I`**. Accepts registry ref (`alpine`, `python:3.12-alpine`), `docker save` archive (`./myapp.tar` or `-` for stdin), or unpacked rootfs dir (`./rootfs/`). Bare name is ALWAYS a registry reference |
| Network flag | `--net` — "Enable outbound network access". **Bare `--net` = UNRESTRICTED egress** (see Egress semantics below) |
| Branchable flag | `--branchable` — on `machine start` [aliases: `--forkable`]. On `machine branch`: `--branchable` [aliases: `--forkable`, `--checkpointable`]. Makes a machine a branch source (memfd CoW RAM + control socket) |
| Name flag | `-n, --name <NAME>`. On `exec`: long-only `--name <NAME>` (no `-n` short form on exec). Default machine name: `"default"` |
| `machine create` trailing workload | **Yes**: `Usage: smolvm machine create [OPTIONS] [-- <COMMAND>...]`. Help states: "`last = true` requires the `--` separator" — the `--` IS required before the workload command |
| Remove subcommand name | **`delete`** [alias: `rm`]. Usage: `smolvm machine delete [OPTIONS] --name <NAME>` (name REQUIRED; `-f/--force` skips confirmation; `--cascade` removes children first). `remove` is NOT a valid subcommand (exit 2, "unrecognized subcommand 'remove'") |
| `exec` command syntax | `Usage: smolvm machine exec [OPTIONS] <COMMAND>...` — command is a plain trailing positional; **`--` accepted but NOT required** (verified empirically: both `exec --name x -- echo hi` and `exec --name x echo hi` work; `sh -c "..."` nesting works). The binary's own hint text uses `--` |
| List subcommand | `ls` [alias: `list`] — `smolvm machine ls [-v|--verbose] [--json] [-q|--quiet]`. `--json` reads back labels |
| Egress denial inspection | `smolvm machine egress-events [-n NAME] [--limit N] [--json]` — "Show egress denials — outbound connections the machine's egress policy refused" |

### Egress semantics — CRITICAL for the adapter (empirically verified)

The egress model is **opt-in, and `--net` alone is allow-ALL**:

1. **No net flags at all** → NO outbound network, not even DNS. Image pulls happen INSIDE the guest, so `machine run --image alpine` fails on first use ("network is unreachable" — smolvm prints a hint: `Add --net to enable image pulls`).
2. **`--net` alone** → outbound network ENABLED and **UNRESTRICTED** (verified: `wget https://example.com` succeeded, exit 0).
3. **`--allow-host <H>` / `--allow-cidr <C>` (each implies `--net`)** → **allowlist mode**: allowed hostnames resolve and connect; everything else fails guest DNS ("bad address"). Verified: with `--allow-host registry.npmjs.org`, npmjs → `EGRESS_OK`, example.com → `wget: bad address 'example.com'`, exit 1.

**Adapter rule (Task 8):** for sandboxed egress, pass `--allow-host`/`--allow-cidr` for each needed host — do NOT pass bare `--net` (that is full outbound). For fully network-less sandboxes, pass NO net flags at all, and prime the image via `--oci-cache` (below).

### Image pull / OCI cache — CRITICAL for the adapter (empirically verified)

- The image pull runs inside the guest → any first-time pull needs egress for the registry (or a proxied pull via `--proxy`).
- `machine run --net --oci-cache --image alpine …` bakes the image into a host cache once ("✓ baked in 8s").
- Later `machine run --oci-cache --image alpine …` (no `--net`) hits the cache: "Using cached image 8905a4de9a369215 (host cache hit; no pull)" and boots fully offline.
- **Caveat:** the detached/persistent path (`machine run -d --name X`) did NOT honor `--oci-cache` in our test (still attempted in-guest pull); persistent `create`+`start` pulls need `--net` once.

---

## SMOKE TEST RESULTS (exact outputs)

### Smoke 1 — KVM boot, ephemeral VM

Command (per plan, first attempt — FAILED as expected without cached image):

```
$ smolvm machine run --image alpine -- sh -c "uname -a"
Starting ephemeral machine (vm-99f84d92)...
Pulling image alpine...Pulling image alpine... done.
Error: agent operation failed: pull image: agent operation failed: pull image: crane manifest failed: 2026/09/22 11:59:46 retrying dial tcp: lookup index.docker.io on 1.1.1.1:53: dial udp 1.1.1.1:53: connect: network is unreachable
...
Hint: networking is disabled. Add --net to enable image pulls:
  smolvm machine run --net --image alpine ...
RUN_EXIT=1
```

One-time cache priming (image pull is in-guest, needs egress once):

```
$ smolvm machine run --net --oci-cache --image alpine -- sh -c "uname -a"
Caching image 8905a4de9a369215 (one-time; reused on later runs)
  · pulling image and running init...
  · snapshotting...
  ✓ baked in 8s
Linux container 6.12.95 #1 SMP PREEMPT_DYNAMIC Mon Jun  1 16:28:39 CEST 2026 x86_64 Linux
RUN_EXIT=0
```

Exact planned command after priming — **PASSES, KVM path proven end-to-end**:

```
$ smolvm machine run --oci-cache --image alpine -- sh -c "uname -a"
Using cached image 8905a4de9a369215 (host cache hit; no pull)
Linux container 6.12.95 #1 SMP PREEMPT_DYNAMIC Mon Jun  1 16:28:39 CEST 2026 x86_64 Linux
RUN_EXIT=0
```

Guest kernel: `Linux container 6.12.95 #1 SMP PREEMPT_DYNAMIC Mon Jun  1 16:28:39 CEST 2026 x86_64 Linux` (host kernel 7.2.5 → guest sees libkrun's kernel 6.12.95).

### Smoke 2 — egress allowlist allows permitted host — PASSES

```
$ smolvm machine run --net --image alpine --allow-host registry.npmjs.org -- sh -c "wget -q -T 5 -O /dev/null https://registry.npmjs.org && echo EGRESS_OK || echo EGRESS_FAIL"
Starting ephemeral machine (vm-5e25dceb)...
Pulling image alpine... [====================] 100% — syncing... done.
EGRESS_OK
RUN_EXIT=0
```

### Smoke 3 — denial proof

As literally specified in the plan (`--net` alone) — **does NOT deny**; plain `--net` is allow-all:

```
$ smolvm machine run --net --image alpine -- sh -c "wget -q -T 3 -O /dev/null https://example.com; echo DENIED_EXIT=$?"
Starting ephemeral machine (vm-90596a32)...
Pulling image alpine... [====================] 100% — syncing... done.
DENIED_EXIT=0
RUN_EXIT=0
```

Corrected denial proof (allowlist mode) — **PASSES, deny-by-default proven**:

```
$ smolvm machine run --net --image alpine --allow-host registry.npmjs.org -- sh -c "wget -q -T 5 -O /dev/null https://example.com; echo DENIED_EXIT=$?"
Starting ephemeral machine (vm-6bc85450)...
Pulling image alpine... [====================] 100% — syncing... done.
DENIED_EXIT=1
wget: bad address 'example.com'
RUN_EXIT=0
```

---

## VERBATIM HELP OUTPUT

### `smolvm --help` (top of output — platform table + quick reference)

```text
# smolvm — Agent Reference

A tool to build and run portable, self-contained virtual machines locally. <200ms boot time. No daemon, no Docker.

## Platform Support

| Host | Guest | Hypervisor | Requirements |
|------|-------|------------|--------------|
| macOS Apple Silicon | arm64 Linux | Hypervisor.framework | macOS 11+ |
| Linux x86_64 / aarch64 | matching Linux | KVM | `/dev/kvm` |
| Windows x86_64 | x86_64 Linux | Windows Hypervisor Platform (WHP) | WHP feature enabled |
```

(Quick-reference excerpt relevant to the adapter:)

```text
# Ephemeral (cleaned up after exit)
smolvm machine run --net --image alpine -- echo hello
smolvm machine run --net -it --image alpine -- /bin/sh   # interactive shell

# Persistent (survives across exec sessions and stop/start)
smolvm machine create --net --name myvm
smolvm machine start --name myvm
smolvm machine exec --name myvm -- apk add python3   # installs persist
smolvm machine stop --name myvm
smolvm machine delete --name myvm
```

### `smolvm machine --help`

```text
Manage machines (create, start, stop, exec) (boxed: the machine arg structs dwarf every other variant)

Usage: smolvm machine <COMMAND>

Commands:
  run               Run a container image in an ephemeral machine
  exec              Run a command directly in the VM (not in a container)
  create            Create a new named machine configuration
  start             Start a machine
  branch            Branch a running branchable machine into an independent child (CoW memory + disks) [aliases: fork]
  checkpoint        Save a running machine, including RAM, as a portable checkpoint
  checkpoint-prune  Remove unused objects from a checkpoint store
  branch-release    Assign parameters and release one held branch-pool slot [aliases: fork-release]
  stop              Stop a running machine
  delete            Delete a machine configuration [aliases: rm]
  status            Show machine status
  egress-events     Show egress denials — outbound connections the machine's egress policy refused
  ls                List all machines [aliases: list]
  update            Modify settings on a stopped machine (mounts, ports, resources, disks)
  images            List cached images and storage usage
  prune             Remove unused images and layers to free disk space
  shell             Open an interactive shell in a machine (starts it if stopped) [aliases: sh]
  cp                Copy files between host and machine
  sync              Synchronize guest-local staged mounts back to their host directories
  monitor           Monitor a machine with health checks and restart policy
  data-dir          Print the on-disk data directory path for a named machine
  help              Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

### `smolvm machine create --help`

```text
Create a new named machine configuration

Usage: smolvm machine create [OPTIONS] [-- <COMMAND>...]

Arguments:
  [COMMAND]...
          Command to run as the machine's persistent workload (image machines). Launched as a detached container on every `start`, so it stays running (e.g. a pre-warmed browser to be branched). Without this, the image's own ENTRYPOINT/CMD is launched instead; if the image defines neither (e.g. a bare rootfs directory), the machine boots to just the agent and commands come from `exec`/`shell`.
          
          `last = true` requires the `--` separator. With the machine name now a flag, a bare positional (an old-style `machine create myvm`) must fail loudly instead of being silently captured as the workload command.

Options:
  -n, --name <NAME>
          Name for the machine (auto-generated if omitted)

      --label <KEY=VALUE>
          Attach metadata to the machine (repeatable), e.g. `--label owner=exo --label sandbox=agent-7`.
          
          smolvm never interprets these. They exist so a process managing many machines can identify its own later — which sandbox a machine serves, who created it, whether it may be reclaimed — instead of encoding that into the name. Read them back with `machine ls --json`.

  -I, --image <IMAGE>
          Container image: a registry reference (alpine, python:3.12-alpine), a `docker save` archive (./myapp.tar, or `-` to read one from stdin), or an unpacked rootfs directory (./rootfs/). A bare name is always a registry reference — pipe `docker save` to use a locally built image

      --max-image-size <SIZE>
          Raise the max accepted local image-archive size (e.g. 16GiB, 512M, or a raw byte count); default 8GiB. For legitimately large images — sets SMOLVM_MAX_IMAGE_BYTES for this run

      --cpus <N>
          Maximum vCPUs the machine may use [default: 4, or the Smolfile/pack value]. Idle vCPUs cost nothing; this caps consumption, not a reservation

      --mem <MiB>
          Maximum memory in MiB the machine may use [default: 8192, or the Smolfile/pack value]. Elastic: only touched memory is committed

      --storage <GiB>
          Storage disk size in GiB (for OCI layers and container data)

      --overlay <GiB>
          Overlay disk size in GiB (for persistent rootfs changes)

      --block-io <BLOCK_IO>
          Host block I/O engine. Async uses restricted io_uring for raw disks on Linux

          Possible values:
          - sync:  Service one request at a time on the virtio block worker
          - async: Submit queued raw-disk reads through a restricted Linux io_uring

      --disk <PATH[:ro]>
          Attach a host disk image or block device (repeatable), appearing in the guest as /dev/vdc, /dev/vdd, ... in the order given. Append `:ro` for read-only. The disk is handed over raw — smolvm never formats or mounts it — so a machine can put, say, a database's WAL on a different device from its data

  -v, --volume <HOST|REMOTE:GUEST[:ro|rw|staged]>
          Mount host directory (can be used multiple times). Also accepts S3-compatible object storage, mounted inside the guest on every start: `s3://bucket/prefix:/data[:ro]` (credentials from --env AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, optional AWS_ENDPOINT_URL for R2/MinIO; anonymous without them). Nothing is required of the image: the agent performs the mount itself. `:staged` runs from a guest-local copy for metadata-heavy workloads; `machine sync` and graceful stop copy it back, so do not modify its host source concurrently

      --allow-system-mounts
          Allow trusted read-only host `/etc` and `/var/log` mounts below `/host`. This exposes sensitive host data to the guest and must not be used for untrusted workloads

  -p, --port <PORT[-END]|HOST[-END]:GUEST[-END]>
          Expose port from VM to host (single port or one-to-one range, repeatable)

      --net
          Enable outbound network access

      --net-backend <NET_BACKEND>
          Select the networking backend

          Possible values:
          - tsi:        Use libkrun TSI networking
          - virtio-net: Use virtio-net with the host-side smolvm network stack

      --dns <IP>
          Custom DNS resolver for the guest (implies --net). Use this when the default public resolvers (8.8.8.8/1.1.1.1) are blocked on your network

      --network <NAME>
          Join a named inter-VM network (implies --net, virtio-net only): members get distinct addresses and can reach each other directly

      --allow-cidr <CIDR>
          Allow egress to specific CIDR range (can be used multiple times, implies --net)

      --allow-host <HOSTNAME>
          Allow egress to specific hostname, resolved at VM start (can be used multiple times, implies --net)

      --outbound-localhost-only
          Restrict outbound to localhost only (implies --net)

      --gpu
          Enable GPU acceleration (Vulkan via virtio-gpu)

      --nested
          Expose the host's virtualization extensions so the guest can run KVM -- i.e. run smolvm, QEMU or another hypervisor inside the machine. Off by default: nesting turns work the guest would do natively into vmexits

      --gpu-vram <MiB>
          GPU shared-memory region size in MiB. Ignored without --gpu. Default 4096 (4 GiB). Must be > 0

      --rosetta
          Enable Rosetta 2 for x86_64 binary translation on Apple Silicon

      --expose-socket <GUEST_PATH[:HOST_PATH]>
          Expose a Unix socket the guest listens on to the host (repeatable). The host reaches it at the given host path, or `<vm-dir>/<basename>` by default. Format: GUEST_PATH[:HOST_PATH]

      --mount-socket <HOST_PATH:GUEST_PATH>
          Mount a host Unix socket into the guest (repeatable), so a guest process reaches the host service at GUEST_PATH. Format: HOST_PATH:GUEST_PATH

      --init <COMMAND>
          Run command on every VM start (can be used multiple times)

  -e, --env <KEY=VALUE>
          Set environment variable (can be used multiple times)

  -w, --workdir <DIR>
          Set working directory inside the machine

  -u, --user <USER>
          Run the workload as this user, like `docker run --user`: a name from the image or a numeric `uid[:gid]`. Overrides the image's USER, so a workload can match the owner of a mounted host directory. `init` commands still run as root

      --ssh-agent
          Forward host SSH agent into the VM (enables git/ssh without exposing keys)

      --cuda
          Remote guest CUDA Driver-API calls to the host NVIDIA GPU over vsock

      --auto-graph
          Ask compatible CUDA frameworks to graph safe compiled regions. Implies --cuda; arbitrary eager CUDA calls are not captured

      --docker-socket
          Expose the guest's Docker daemon socket to the host as a Unix socket (DOCKER_HOST=unix://…). Requires dockerd running in the VM

      --secret-env <GUEST_VAR=HOST_VAR>
          Inject a secret from a host env var (GUEST_VAR=HOST_VAR), resolved at each launch. Only the reference is persisted, never the value

      --secret-file <GUEST_VAR=PATH>
          Inject a secret from a host file (GUEST_VAR=/abs/path), resolved at each launch. Only the reference is persisted, never the value

      --smolfile <PATH>
          Load configuration from a Smolfile (TOML)
          
          [aliases: -s]

      --from <PATH>
          Create from a `.smolmachine` pack or restore a `.smolcheckpoint`

  -h, --help
          Print help (see a summary with '-h')
```

### `smolvm machine start --help`

```text
Start a machine

Usage: smolvm machine start [OPTIONS]

Options:
  -n, --name <NAME>                  Machine to start (default: "default")
      --branchable                   Start as a branch source: back guest RAM with a memfd (CoW-cloneable) and expose a control socket so the running machine can later be branched [aliases: --forkable]
      --branch-pool-size <CHILDREN>  Plan a CUDA branch pool with this many runnable children. Smolvm reports a safe per-session VRAM share before the source initializes, so vLLM and similar runtimes size private caches without workload changes. Implies --branchable [aliases: --fork-pool-size]
      --cuda-vram-limit-mib <MIB>    Override the automatic logical VRAM budget for each source/child CUDA session. The workload still needs no changes. Requires --branch-pool-size
  -h, --help                         Print help

Network:
      --proxy <URL>      Proxy URL used for the in-VM image pull (sets HTTP_PROXY and HTTPS_PROXY on the registry client). Example: `http://192.168.127.254:3128`
      --no-proxy <LIST>  Comma-separated NO_PROXY list of hosts/CIDRs that bypass the proxy during image pull. Example: `127.0.0.1,localhost,.internal`
```

### `smolvm machine exec --help`

```text
Run a command directly in the VM (not in a container)

Usage: smolvm machine exec [OPTIONS] <COMMAND>...

Arguments:
  <COMMAND>...  Command and arguments to execute

Options:
      --name <NAME>
          Target machine (default: "default")
  -w, --workdir <DIR>
          Set working directory in the VM
  -u, --user <USER>
          Run as this user (name or `uid[:gid]`). Defaults to the machine's configured user, then the image's USER
  -e, --env <KEY=VALUE>
          Set environment variable (can be used multiple times)
      --secret-env <GUEST_VAR=HOST_VAR>
          Inject a secret from a host env var (GUEST_VAR=HOST_VAR) for this exec, resolved on the host. The value never persists to the record
      --secret-file <GUEST_VAR=PATH>
          Inject a secret from a host file (GUEST_VAR=/abs/path) for this exec, resolved on the host. The value never persists to the record
      --timeout <DURATION>
          Kill command after duration (e.g., "30s", "5m")
  -i, --interactive
          Keep stdin open for interactive input
  -t, --tty
          Allocate a pseudo-TTY (use with -i for shells)
      --stream
          Stream output in real-time (prints as it arrives)
  -d, --detach
          Detach: spawn the command in the background and return its PID immediately. The process keeps running (it is not killed when this command returns), so it can host long-lived services — e.g. a server bound to a published port. Incompatible with -i/-t and --stream
  -h, --help
          Print help
```

### `smolvm machine stop --help`

```text
Stop a running machine

Usage: smolvm machine stop [OPTIONS]

Options:
  -n, --name <NAME>  Machine to stop (default: "default")
  -h, --help         Print help
```

### `smolvm machine delete --help` (alias `rm`; `remove` does NOT exist)

```text
Delete a machine configuration

Usage: smolvm machine delete [OPTIONS] --name <NAME>

Options:
  -n, --name <NAME>  Machine to delete
  -f, --force        Skip confirmation prompt
      --cascade      Also delete any children branched from this machine. A branch source cannot be removed while its children's disks depend on it; --cascade removes children first. Implies no confirmation
  -h, --help         Print help
```

### `smolvm machine run --help`

```text
Run a container image in an ephemeral machine

Usage: smolvm machine run [OPTIONS] [COMMAND]...

Arguments:
  [COMMAND]...
          Command and arguments to run (default: image entrypoint or /bin/sh)

Options:
  -I, --image <IMAGE>
          Container image: a registry reference (alpine, ubuntu:22.04, ghcr.io/org/image), a `docker save` archive (./myapp.tar, or `-` to read one from stdin), or an unpacked rootfs directory (./rootfs/). A bare name is always a registry reference — pipe `docker save` to use a locally built image. Optional when a Smolfile provides the image, or for bare VM mode

      --init <COMMAND>
          Run command before the workload (can be used multiple times); the same as `init` in a Smolfile, and the CLI form wins when both are given. Init provisions the machine, so it runs as root regardless of `--user` or the image's USER

  -h, --help
          Print help (see a summary with '-h')

Execution:
      --max-image-size <SIZE>
          Raise the max accepted local image-archive size (e.g. 16GiB, 512M, or a raw byte count); default 8GiB. For legitimately large images — sets SMOLVM_MAX_IMAGE_BYTES for this run

  -n, --name <NAME>
          Name a persistent machine when used with --detach. Matches the --name flag on start/stop/exec/status/resize. In foreground mode (no -d), --name is ignored with a warning

  -d, --detach
          Start the command in the background and detach, leaving the VM running. Use `machine exec` to run further commands against the VM and `machine stop` to tear it down

  -i, --interactive
          Keep stdin open for interactive input

  -t, --tty
          Allocate a pseudo-TTY (use with -i for interactive shells)

      --timeout <DURATION>
          Kill command after duration (e.g., "30s", "5m", "1h")

Machine source:
      --from <PATH>
          Run a packed `.smolmachine` artifact ephemerally (the VM is discarded on exit) — the one-shot equivalent of `machine create --from … + start`. CPU/memory fall back to the artifact's baked manifest unless overridden

Container:
  -w, --workdir <DIR>
          Set working directory inside container

  -u, --user <USER>
          Run as this user, like `docker run --user`: a name from the image or a numeric `uid[:gid]`. Overrides the image's USER

  -e, --env <KEY=VALUE>
          Set environment variable (can be used multiple times)

      --oci-platform <OS/ARCH>
          Target OCI platform for multi-arch images

  -v, --volume <HOST|REMOTE:CONTAINER[:ro|rw|staged]>
          Mount host directory into container (can be used multiple times). Also accepts S3-compatible object storage, mounted inside the container: `s3://bucket/prefix:/data[:ro]` (credentials from --env AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, optional AWS_ENDPOINT_URL for R2/MinIO; anonymous without them). Nothing is required of the image: the agent performs the mount itself. `:staged` runs from a guest-local copy for metadata-heavy workloads; `machine sync` and graceful stop copy it back, so do not modify its host source concurrently

      --allow-system-mounts
          Allow trusted read-only host `/etc` and `/var/log` mounts below `/host`. This exposes sensitive host data to the guest and must not be used for untrusted workloads

Network:
  -p, --port <PORT[-END]|HOST[-END]:GUEST[-END]>
          Expose port from container to host (single port or one-to-one range, repeatable)

      --net
          Enable outbound network access

      --net-backend <NET_BACKEND>
          Select the networking backend

          Possible values:
          - tsi:        Use libkrun TSI networking
          - virtio-net: Use virtio-net with the host-side smolvm network stack

      --dns <IP>
          Custom DNS resolver for the guest (implies --net). Use this when the default public resolvers (8.8.8.8/1.1.1.1) are blocked on your network

      --network <NAME>
          Join a named inter-VM network (implies --net, virtio-net only): members get distinct addresses and can reach each other directly

      --allow-cidr <CIDR>
          Allow egress to specific CIDR range (can be used multiple times, implies --net)

      --allow-host <HOSTNAME>
          Allow egress to specific hostname, resolved at VM start (can be used multiple times, implies --net)

      --outbound-localhost-only
          Restrict outbound to localhost only (implies --net)

      --allow-host-loopback
          Let the guest reach services on the HOST's own loopback (127.0.0.1 / ::1); off by default so a sandbox can't reach host debuggers, Docker, or local databases. Cloud-metadata stays blocked. Implies --net

      --docker-socket
          Expose the guest's Docker daemon socket to the host as a Unix socket (DOCKER_HOST=unix://…). Requires dockerd running in the VM

      --proxy <URL>
          Proxy URL used for the in-VM image pull (sets HTTP_PROXY and HTTPS_PROXY on the registry client). Example: `http://192.168.127.254:3128`

      --no-proxy <LIST>
          Comma-separated NO_PROXY list of hosts/CIDRs that bypass the proxy during image pull. Example: `127.0.0.1,localhost,.internal`

Resources:
      --gpu
          Enable GPU acceleration (Vulkan via virtio-gpu)

      --nested
          Expose the host's virtualization extensions so the guest can run KVM -- i.e. run smolvm, QEMU or Docker Desktop's hypervisor inside the machine. Off by default: nesting turns work the guest would do natively into vmexits, so a nested guest runs far slower

      --gpu-vram <MiB>
          GPU shared-memory region size in MiB. Ignored without --gpu. Default 4096 (4 GiB). Must be > 0

      --rosetta
          Enable Rosetta 2 for x86_64 binary translation on Apple Silicon

      --cpus <N>
          Maximum vCPUs the machine may use [default: 4]. Idle vCPUs cost nothing; this caps what the workload can consume, it does not reserve it

      --mem <MiB>
          Maximum memory in MiB the machine may use [default: 8192]. Memory is elastic: the host commits only what the guest touches, up to this cap

      --storage <GiB>
          Writable data disk size in GiB (default 20). Bounds how much a workload can write: a disk-heavy or untrusted command fills this disk (ENOSPC), never the host. This is the flag to lower when sandboxing untrusted code

      --overlay <GiB>
          Container rootfs overlay (copy-on-write upper layer) size in GiB. NOT the writable-data cap — use --storage to bound how much a workload can write. Rarely needs setting

      --block-io <BLOCK_IO>
          Host block I/O engine. Async uses restricted io_uring for raw disks on Linux

          Possible values:
          - sync:  Service one request at a time on the virtio block worker
          - async: Submit queued raw-disk reads through a restricted Linux io_uring

      --disk <PATH[:ro]>
          Attach a host disk image or block device (repeatable), appearing in the guest as /dev/vdc, /dev/vdd, ... in the order given. Append `:ro` for read-only. The disk is handed over raw — smolvm never formats or mounts it — so a machine can put, say, a database's WAL on a different device from its data

      --smolfile <PATH>
          Load VM configuration from a Smolfile (TOML)
          
          [aliases: -s]

      --no-init-cache
          Skip the init-layer cache: re-run `init` on every ephemeral run instead of baking `image + init` once into a cached, reusable artifact. Use this when `init` depends on live volume contents (and so cannot be safely cached)

      --rebuild-init-cache
          Rebuild the cached init layer even if a matching one already exists

      --oci-cache
          Cache the pulled OCI image on the host so repeat ephemeral runs of the same `--image` skip the registry pull. The image is baked once into a reusable `.smolmachine` (keyed by image + env) and every later run rehydrates from it instead of re-pulling inside the guest. The VM stays throwaway; only the image is cached. Registry images only

Security:
      --ssh-agent
          Forward host SSH agent into the VM (enables git/ssh without exposing keys)

      --secret-env <GUEST_VAR=HOST_VAR>
          Inject a secret from a host env var (GUEST_VAR=HOST_VAR), resolved at launch. The value is never persisted to the machine record or a pack

      --secret-file <GUEST_VAR=PATH>
          Inject a secret from a host file (GUEST_VAR=/abs/path), resolved at launch. The value is never persisted to the machine record or a pack

      --unprivileged
          Run the workload as an unprivileged container: restricted capabilities, read-only cgroup, and no extra tmpfs. By default the workload is "VM-grade" (the microVM is the isolation boundary, so it gets full privileges and any image — incl. systemd — boots). Use this for defense-in-depth with untrusted code. `init` always runs VM-grade (it needs privileges for apt/mounts)

Hardware:
      --cuda
          Remote guest CUDA Driver-API calls to the host NVIDIA GPU over vsock

      --auto-graph
          Ask compatible CUDA frameworks to graph safe compiled regions. Implies --cuda; arbitrary eager CUDA calls are not captured

Registry:
      --docker-config
          Mount ~/.docker/ into the VM. Registry credentials from `docker login` (credential helpers included) are resolved on the host for every pull, so this is only needed for other contents of the directory
```

### `smolvm machine branch --help` (alias `fork`; needed in Phase 3)

```text
Branch a running branchable machine into an independent child (CoW memory + disks)

Usage: smolvm machine branch [OPTIONS] --from <NAME>

Options:
      --from <NAME>
          The running, branchable source machine to branch from [aliases: --golden]
  -n, --name <NAME>
          Name for the new child machine
      --count <COUNT>
          Number of children to create from one checkpoint. Batch branches wait for the standard `smolvm-branch-ready` boundary automatically. Direct batches receive one shared `SMOLVM_BRANCH_BATCH_ID` and `SMOLVM_BRANCH_BATCH_SIZE`; held slots remain independent until assigned by their controller [default: 1]
      --name-prefix <PREFIX>
          Name batch children PREFIX-0 through PREFIX-(COUNT-1). With a prefix (or --hold) even a count of one is a batch: it waits for the boundary and releases the child with its identity, unlike a plain --name branch
      --parallel <COUNT>
          Maximum number of child boots in flight during a batch branch [default: 4]
      --wait-ready
          Wait for `smolvm-branch-ready` in a single-child branch. Batch branches always wait; unless held, they release children only after identity and branch env are installed
      --hold
          Keep each child parked at the inherited branch point as an already-booted pool slot. Assign and release a slot later with `machine branch-release`. A consumed slot is disposable; delete and replenish it from the source rather than reusing mutated training state
      --ready-timeout <DURATION>
          Maximum time to wait for the source workload's branch boundary [default: 10m]
      --wait-worker-ready
          Count a batch child as branched only once its workload has run `smolvm-worker-ready`; a child that does not within the window is torn down with the rest of the batch. Held slots take this at release
      --worker-ready-timeout <DURATION>
          Window for `--wait-worker-ready` [default: 5m]
      --branchable
          Make the child itself branchable (memfd RAM + control socket), so it can in turn be branched [aliases: --forkable, --checkpointable]
      --share-weights
          Share the source's loaded CUDA weights with this child instead of copying them — sibling children then keep ONE copy of the base model in VRAM. Correct when the base stays frozen (LoRA/QLoRA fine-tuning, inference); use a plain branch when the child trains the base weights
  -e, --env <KEY=VALUE>
          Per-branch parameter (repeatable, KEY=VALUE). Reaches the child through `smolvm-branch-ready`: the program it runs (`-- prog`) gets it in its environment, a shell gets it from `eval "$(smolvm-branch-ready)"`, and later `machine exec` sessions see it too. This is how sweep/rollout children learn which variant they are — no shared-mount claim files needed
  -h, --help
          Print help

Network:
  -p, --port <PORT[-END]|HOST[-END]:GUEST[-END]>
          Pin the child's inbound port forwards (single port or one-to-one range, repeatable). Without this, the source's forwards are remapped to freshly-allocated host ports

Security:
      --secret-env <GUEST_VAR=HOST_VAR>
          Inject a per-branch secret from a host env var (GUEST_VAR=HOST_VAR), resolved fresh on every `exec` in the child. Unlike `--env`, the value is never written to the child's record, the overlay/pack, or the branch-env guest file — and each child's secrets are its own, invisible to the source and siblings
      --secret-file <GUEST_VAR=PATH>
          Inject a per-branch secret from a host file (GUEST_VAR=/abs/path), resolved fresh on every `exec` in the child. Never persisted to the record, overlay/pack, or branch-env guest file. See `--secret-env`
```

### `smolvm machine ls --help` (canonical `ls`, alias `list`)

```text
List all machines

Usage: smolvm machine ls [OPTIONS]

Options:
  -v, --verbose  Show detailed configuration (mounts, ports, PID)
      --json     Output in JSON format
  -q, --quiet    Print only machine names, one per line
  -h, --help     Print help
```

### `smolvm machine egress-events --help`

```text
Show egress denials — outbound connections the machine's egress policy refused

Usage: smolvm machine egress-events [OPTIONS]

Options:
  -n, --name <NAME>    Machine to inspect (default: "default")
      --limit <LIMIT>  Maximum number of events to show (newest kept) [default: 200]
      --json           Output in JSON format
  -h, --help           Print help
```

### `smolvm pack create --help`

```text
Package an OCI image or VM snapshot into a self-contained executable

Usage: smolvm pack create [OPTIONS] --output <PATH>

Options:
  -I, --image <IMAGE>
          Container image to pack (e.g., alpine:latest, python:3.11-slim)

      --from-vm <VM_NAME>
          Pack from a stopped VM snapshot instead of an OCI image

      --rebase-from-image
          Re-pull the base image instead of preserving cached or imported layers (may resolve a newer image tag)

      --include-workspace
          Also capture the machine's /workspace, so a machine made from the pack starts with those files. It lives on the storage disk, which packs otherwise never carry

  -o, --output <PATH>
          Output file path for the packed binary

      --cpus <N>
          Maximum vCPUs machines from this pack may use [default: 4, or the Smolfile value]. A cap on consumption, not a reservation

      --mem <MiB>
          Maximum memory in MiB machines from this pack may use [default: 8192, or the Smolfile value]. Elastic: only touched memory is committed

      --oci-platform <OS/ARCH>
          Target OCI platform for multi-arch images (e.g., linux/arm64, linux/amd64)
          
          By default, uses the host architecture. Use this to override, for example to pack x86_64 images for Rosetta on Apple Silicon.

      --entrypoint <CMD>
          Override the image entrypoint

      --no-sign
          Skip code signing (macOS only)

      --single-file
          Pack as a single file (no sidecar)
          
          Creates one executable instead of binary + .smolmachine sidecar. Simpler to distribute but may have issues with macOS notarization.

      --smolfile <PATH>
          Load workload configuration from a Smolfile (TOML)
          
          [aliases: -s]

      --gpu
          Enable GPU acceleration (Vulkan via virtio-gpu) in the packed VM
          
          The packed binary will launch with a virtio-gpu device. The guest image must include a compatible Vulkan ICD (e.g., Mesa Venus on Fedora via the slp/mesa-libkrun-vulkan COPR, or standard Mesa on Linux hosts).

      --staging-dir <DIR>
          Directory under which to stage pack assets (pulled layers, the merged layer, agent rootfs, and the ext4 template). Defaults to the smolvm cache dir; point this at a roomy disk-backed path when the default filesystem is small. Overrides the `SMOLVM_PACK_STAGING` env var

  -h, --help
          Print help (see a summary with '-h')

Network:
      --proxy <URL>
          Proxy URL used for the in-VM image pull (sets HTTP_PROXY and HTTPS_PROXY on the registry client). Example: `http://192.168.127.254:3128`

      --no-proxy <LIST>
          Comma-separated NO_PROXY list of hosts/CIDRs that bypass the proxy during image pull. Example: `127.0.0.1,localhost,.internal`
```

---

## Port publishing (verified 2026-09-22, Phase 2 spike)

Mechanism: **`-p, --port <PORT[-END]|HOST[-END]:GUEST[-END]>`** — "Expose port from VM to host (single port or one-to-one range, repeatable)". Valid on `machine create`, `machine run`, `machine branch` (pins child forwards), and `machine update` (`-p` adds, `--remove-port` removes; stopped machine only).

### Empirical matrix (all against the baked `alpine3` pack; host `curl` against an in-guest busybox-nc listener)

Listener recipe used in every test (verified working — busybox nc in alpine3 supports `-l -p PORT -e PROG`):

```sh
# 1. response file in guest (NOTE: /tmp is tmpfs — recreate after every stop/start)
smolvm machine exec --name <vm> -- sh -c 'printf "HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nCDP-OK\n" > /tmp/resp'
# 2. persistent listener, detached (exec -d exists exactly for this: "can host long-lived services — e.g. a server bound to a published port")
smolvm machine exec --name <vm> -d -- sh -c 'while true; do nc -l -p 9222 -e cat /tmp/resp; done'
# 3. from the HOST
curl -s --max-time 3 http://127.0.0.1:9222/   # → CDP-OK
```

| # | Backend | Net state | Create flags | Host `curl 127.0.0.1:9222` |
|---|---------|-----------|--------------|----------------------------|
| 1 | tsi (default) | enabled (pack default) | `-p 9222:9222` | `CDP-OK`, exit 0 |
| 2 | tsi (default) | **disabled** (`machine update --no-net`) | same | **curl exit 52, empty reply** — host socket still binds, guest listener verified alive (`ps` in guest), but no data path |
| 3 | tsi (default) | re-enabled (`machine update --net`) | same | `CDP-OK`, exit 0 |
| 4 | virtio-net | enabled | `--net-backend virtio-net -p 9222:9222` | `CDP-OK`, exit 0 |
| 5 | virtio-net | **disabled** (`machine update --no-net`) | same | **`CDP-OK`, exit 0 — inbound publish survives `--no-net` on virtio-net** |
| 6 | virtio-net (forced) | allowlist egress | `--allow-host example.com -p 9222:9222` | `CDP-OK`, exit 0; allowlist verified active (example.com `EGRESS_OK`, registry.npmjs.org `EGRESS_FAIL` / `wget: bad address`) |

### Verified facts

> **⚠️ CORRECTION (Task 2 follow-up, backend-aware sealing):** the spike's earlier claim — "virtio-net + `--no-net` = sealed" (fact 3's "zero outbound") — is **WRONG for egress**. `machine update --no-net` only flips the record's net flag; on virtio-net **outbound stays OPEN** (the host-side virtio-net stack keeps forwarding). `--no-net` seals TSI boots only. A port-publishing VM (which requires `--net-backend virtio-net`) must be sealed at **CREATE time** with `--outbound-localhost-only`: host loopback stays reachable (what CDP needs), all other egress denied. NEVER seal a port VM with `update --no-net` — it seals nothing on virtio-net.

1. **Default backend is tsi** (libkrun TSI): a machine record created without `--net-backend` carries no `network_backend` key; one created with `--net-backend virtio-net` stores `"network_backend":"virtio-net"` in `<data-dir>/vm.config.json`.
2. **On tsi, inbound publishing requires network enabled.** `machine update --no-net` keeps the host-side bind (TCP connect succeeds) but the guest never answers → curl exit 52. Re-enabling with `machine update --net` restores forwarding on the same machine.
3. **On virtio-net, inbound publishing works even with `--no-net`.** This is the no-egress-but-host-reachable combination needed for the QA browser VM (CDP inbound, zero outbound). **Tasks 2–4 should create the browser VM with `--net-backend virtio-net`.**
4. **`--allow-host`/`--allow-cidr` force the virtio-net backend** regardless of default (observed in start error text: `configure virtio-net: failed to start virtio network runtime` on a machine with no explicit backend flag). Allowlist egress and inbound publishing coexist fine.
5. **Host-side bind shape:** host port binds on `127.0.0.1:<port>` AND `[::1]:<port>`, owned by the VM's own process (`/proc/self/exe _boot-vm <data-dir>/boot-config.json`) — no separate proxy daemon.
6. **Host-port conflicts are enforced at start:** starting a second machine while a running machine holds the same host port fails (`Error: ... host port 9222 is already in use by running machine 'spike-p2'`). There is also a **brief post-stop release window**: `start` immediately after `stop` of the previous holder failed with `cannot publish host TCP 127.0.0.1:9222 to guest TCP 9222: Address already in use (os error 98)`; a retry seconds later succeeded. Adapters should retry `start` on EADDRINUSE.
7. **Config readback:** `machine ls -v` shows `Port: 9222 -> 9222`; `machine ls --json` exposes a `ports` count only; the full mapping lives in `<machine data-dir>/vm.config.json` as `"ports":[{"host":9222,"guest":9222}]` (file appears once the machine has been started).
8. **Pack default:** the baked `alpine3` pack has network ENABLED with no flags (`machine ls -v` → `Network: enabled` for a fresh no-flag VM) — `-p` alone is sufficient on pack-created machines. `machine create` has no `--no-net` flag; net is only disableable post-create via `machine update --no-net`.
9. **Gotcha:** guest `/tmp` is tmpfs — files written there (e.g. our `/tmp/resp`) vanish on stop/start. One mid-test false alarm (curl 52 after restart) was caused by this, not by forwarding. Long-lived guest state belongs on the storage/overlay disk.

All spike VMs (`spike-p0`…`spike-p3`) were deleted after testing (`machine delete -f`); `machine ls` shows none remaining.

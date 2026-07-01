# Agent image: the real Ubuntu GNOME desktop (Yaru) streamed to the browser over
# noVNC, with Claude Code installed. Modern GNOME Shell needs a proper login
# session, so this image runs **systemd as PID 1** and starts the desktop via
# TigerVNC's session machinery (session=ubuntu-xorg). It must be run with the
# privileged flags documented in the README (cgroups, SYS_ADMIN, tmpfs).
#
# Base is the official Docker `ubuntu` image (docker.io/library/ubuntu:24.04).
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Lite-but-real Ubuntu GNOME desktop + VNC + noVNC. Recommends are intentionally
# kept for the desktop metapackage — GNOME needs them to render correctly.
RUN apt-get update \
    && apt-get install -y \
       ubuntu-desktop-minimal \
       gnome-session gnome-terminal \
       tigervnc-standalone-server tigervnc-common \
       novnc websockify \
       dbus-user-session \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl gnupg git sudo nano \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20 (Claude Code needs Node >=18) + Claude Code CLI
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g @anthropic-ai/claude-code \
    && rm -rf /var/lib/apt/lists/*

# Browser, per arch: Google Chrome on amd64 (no official arm64 build),
# Chromium (.deb, no snap) from the xtradeb PPA on arm64.
# Arch is detected with `dpkg --print-architecture` (amd64 / arm64) so the build
# works on ANY builder — the BuildKit-only TARGETARCH auto-arg is NOT set under
# the classic builder, which is how the gateway builds this image. Placed here
# (not earlier) so the heavy desktop/node layers above stay cached.
RUN set -eux; \
    ARCH="$(dpkg --print-architecture)"; \
    if [ "$ARCH" = "amd64" ]; then \
      install -d -m 0755 /etc/apt/keyrings; \
      curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg; \
      echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google-chrome.list; \
      apt-get update; \
      apt-get install -y --no-install-recommends google-chrome-stable; \
    else \
      apt-get update; \
      apt-get install -y --no-install-recommends software-properties-common; \
      add-apt-repository -y ppa:xtradeb/apps; \
      apt-get update; \
      apt-get install -y --no-install-recommends chromium; \
    fi; \
    rm -rf /var/lib/apt/lists/*

# Mesa userspace drivers so the browser can use a passed-in GPU (/dev/dri):
# radeonsi (AMD GL), radv (Vulkan), VA-API video decode. Harmless on hosts with
# no GPU — the browser just falls back to software. mesa-utils/vainfo aid debug.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       libgl1-mesa-dri libegl-mesa0 mesa-va-drivers mesa-vulkan-drivers \
       libvulkan1 vulkan-tools vainfo mesa-utils \
    && rm -rf /var/lib/apt/lists/*

# Make the browser usable inside a container:
#  --no-sandbox            : the userns sandbox is blocked in containers
#  --test-type             : hide the "unsupported flag" warning bar
#  --password-store=basic  : don't prompt to unlock the GNOME keyring
#  --no-first-run / --no-default-browser-check : skip first-run prompts
#  --disable-dev-shm-usage : write shared memory to /tmp, not the small /dev/shm
#       (Chrome's compositor SIGTRAPs when /dev/shm is the 64MB container default)
#  --ignore-gpu-blocklist --use-gl=angle --use-angle=vulkan --enable-features=Vulkan :
#       use the GPU through ANGLE's Vulkan backend, which drives Mesa RADV on the
#       passed-in /dev/dri render node directly. This is the path that actually
#       reaches the hardware here: the desktop X server is software (Xtigervnc), so
#       the ANGLE-GL/GLX path only ever gets llvmpipe — Vulkan bypasses it and binds
#       the real GPU (verified: "ANGLE (AMD, ... AMD Radeon 680M (RADV REMBRANDT), radv)").
#       --enable-unsafe-swiftshader keeps WebGL working as the software fallback when
#       no GPU is present (AGENT_GPU unset / no /dev/dri).
# Also suppress the TigerVNC clipboard-config window (-iconic -> -nowin).
RUN set -eux; \
    ARCH="$(dpkg --print-architecture)"; \
    FLAGS="--no-sandbox --test-type --password-store=basic --no-first-run --no-default-browser-check --disable-dev-shm-usage --ignore-gpu-blocklist --use-gl=angle --use-angle=vulkan --enable-features=Vulkan --enable-unsafe-swiftshader"; \
    if [ "$ARCH" = "amd64" ]; then \
      DESKTOP=/usr/share/applications/google-chrome.desktop; BIN=google-chrome-stable; \
    else \
      DESKTOP=/usr/share/applications/chromium.desktop; BIN=chromium; \
    fi; \
    sed -i -E "s#^Exec=(/usr/bin/)?${BIN}#Exec=\1${BIN} ${FLAGS}#" "${DESKTOP}"; \
    sed -i 's/tigervncconfig -iconic/tigervncconfig -nowin/' /etc/X11/Xtigervnc-session; \
    # Shadow the system browser binary with a wrapper that always carries the
    # flags. Without this, a bare `google-chrome URL` from CLI / xdotool /
    # xdg-open drops --ignore-gpu-blocklist + --use-angle=vulkan, Chrome's
    # internal WebGL blocklist trips on the amdgpu+RADV combo, and WebGL falls
    # back to llvmpipe even though the GPU is reachable. /usr/local/bin is
    # earlier in PATH than /usr/bin, so this catches every PATH lookup.
    # Direct `/usr/bin/google-chrome-stable` calls (the .desktop Exec line
    # uses an absolute path) still hit the real binary without going through
    # the wrapper — the .desktop already adds the flags itself. \
    install -d /usr/local/bin; \
    printf '#!/bin/sh\nexec /usr/bin/%s %s "$@"\n' "${BIN}" "${FLAGS}" \
      > "/usr/local/bin/${BIN}"; \
    chmod +x "/usr/local/bin/${BIN}"; \
    if [ "${BIN}" = "google-chrome-stable" ]; then \
      ln -sf "${BIN}" /usr/local/bin/google-chrome; \
    fi

# VS Code (official Microsoft apt repo — ships amd64 + arm64) and common CLI
# tools. VS Code is Electron, so it needs --no-sandbox in a container too.
RUN set -eux; \
    ARCH="$(dpkg --print-architecture)"; \
    install -d -m 0755 /etc/apt/keyrings; \
    curl -fsSL https://packages.microsoft.com/keys/microsoft.asc \
      | gpg --dearmor -o /etc/apt/keyrings/microsoft.gpg; \
    echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/code stable main" \
      > /etc/apt/sources.list.d/vscode.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      code \
      ffmpeg build-essential python3-pip python3-venv pipx \
      jq unzip zip wget htop vim ripgrep imagemagick tree xdotool \
    ; \
    sed -i -E 's#^Exec=/usr/share/code/code#Exec=/usr/share/code/code --no-sandbox --password-store=basic#' \
      /usr/share/applications/code.desktop; \
    rm -rf /var/lib/apt/lists/*

# Also wrap the `code` CLI so terminal launches use the basic password store
# too (otherwise VS Code prompts to create a GNOME keyring on a headless agent).
RUN printf '#!/bin/sh\nexec /usr/bin/code --password-store=basic "$@"\n' > /usr/local/bin/code \
    && chmod +x /usr/local/bin/code

# uv — fast Python package/project manager (system-wide; installer picks the arch).
RUN curl -LsSf https://astral.sh/uv/install.sh \
    | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh

# Pin the browser (+ Files, Terminal) to the GNOME dock as default favorites,
# baked as a system dconf default so it applies to fresh agent sessions.
RUN set -eux; \
    ARCH="$(dpkg --print-architecture)"; \
    if [ "$ARCH" = "amd64" ]; then BROWSER=google-chrome.desktop; else BROWSER=chromium.desktop; fi; \
    mkdir -p /etc/dconf/profile /etc/dconf/db/local.d; \
    printf 'user-db:user\nsystem-db:local\n' > /etc/dconf/profile/user; \
    printf "[org/gnome/shell]\nfavorite-apps=['%s', 'code.desktop', 'org.gnome.Nautilus.desktop', 'org.gnome.Terminal.desktop']\n" \
      "$BROWSER" > /etc/dconf/db/local.d/00-favorite-apps; \
    dconf update

# Non-root agent user (uid 1000). Ubuntu 24.04 ships a default `ubuntu` user at
# uid 1000 — remove it first.
RUN userdel -r ubuntu 2>/dev/null || true \
    && useradd -m -s /bin/bash -u 1000 agent \
    && echo "agent ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/agent \
    && chmod 0440 /etc/sudoers.d/agent

# nvm — Node Version Manager, installed for the agent user (hooks ~/.bashrc).
# Coexists with the system Node 20; nvm-selected versions take precedence in
# the agent's interactive shell.
RUN su - agent -c 'export NVM_DIR="$HOME/.nvm"; \
      NVM_VER="$(curl -s https://api.github.com/repos/nvm-sh/nvm/releases/latest | jq -r .tag_name)"; \
      curl -o- "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VER}/install.sh" | bash'

# fish shell, set as the agent user's default login shell.
# (nvm is bash-only and won't load in fish; system Node 20 and uv still work.)
RUN apt-get update \
    && apt-get install -y --no-install-recommends fish \
    && rm -rf /var/lib/apt/lists/* \
    && usermod -s /usr/bin/fish agent

# Suppress the first-run welcome wizard and tour — clean desktop on launch.
RUN apt-get purge -y gnome-initial-setup gnome-tour 2>/dev/null || true
RUN install -d -o agent -g agent /home/agent/.config \
    && echo yes > /home/agent/.config/gnome-initial-setup-done \
    && chown agent:agent /home/agent/.config/gnome-initial-setup-done \
    && install -d -o agent -g agent /home/agent/.claude \
    && echo '{"hasCompletedOnboarding": true}' > /home/agent/.claude.json \
    && chown agent:agent /home/agent/.claude.json

# TigerVNC: map display :1 to the agent user and configure the session.
# SecurityTypes=None — no VNC password; access is via the locally-proxied noVNC.
RUN echo ":1=agent" > /etc/tigervnc/vncserver.users \
    && install -d -o agent -g agent /home/agent/.vnc \
    && printf 'session=ubuntu-xorg\ngeometry=1920x1080\ndepth=24\nSecurityTypes=None\nAlwaysShared\nAcceptSetDesktopSize=0\n' \
       > /home/agent/.vnc/config \
    && chown agent:agent /home/agent/.vnc/config

# noVNC: custom landing page — auto-connects, scales to fit window, no HiDPI.
COPY novnc-index.html /usr/share/novnc/index.html

# websockify (noVNC web) on 6080 -> VNC 5901, managed by systemd.
COPY novnc.service /etc/systemd/system/novnc.service

# (Claude Code is kept current by the agent-runtime: it runs `npm i -g
# @anthropic-ai/claude-code@latest` synchronously right before launching the
# claude session — see claudeBootCommand in runtime/server.js. No separate
# boot service, which used to race the session and could update too late.)

# Apply the agent's timezone (from the TZ env the gateway sets) before the
# desktop session comes up, so the GNOME clock and CLI tools agree.
COPY agent-set-timezone.sh /usr/local/bin/agent-set-timezone
RUN chmod +x /usr/local/bin/agent-set-timezone
COPY agent-timezone.service /etc/systemd/system/agent-timezone.service

# Agent terminal supervisor: multi-session pty over WebSocket (node-pty + ws).
# node-pty is a native addon — build-essential + python3 (installed above) build it.
COPY runtime /opt/agent-runtime
RUN cd /opt/agent-runtime && npm install --omit=dev
COPY agent-terminals.service /etc/systemd/system/agent-terminals.service

# GPU access: grant the agent user the render-node group at boot (if /dev/dri
# was passed in), before the desktop/terminal services come up.
COPY agent-gpu.sh /usr/local/bin/agent-gpu
RUN chmod +x /usr/local/bin/agent-gpu
COPY agent-gpu.service /etc/systemd/system/agent-gpu.service

# MCP tools for Claude Code (computer-use: control the X desktop). Pre-warm the
# uv cache as the agent (resolves python-xlib at build, cached in the home → the
# MCP server starts instantly; no X needed since the script connects lazily).
COPY --chown=agent:agent tools /opt/agent-tools
RUN su - agent -c '/usr/local/bin/uv run --quiet --script /opt/agent-tools/computer_use.py < /dev/null' || true
# oc-go-cc: Anthropic↔OpenCode Go translator that Claude Code talks to when
# an agent's provider is opencodeGo. Handles the dual-endpoint routing
# (/messages for MiniMax/Qwen, /chat/completions for the rest), the
# Kimi/DeepSeek `reasoning_content` ↔ thinking-block translation, and
# tool-call schema differences — all things we'd otherwise have to re-implement
# and keep in sync. AGPL-licensed binary; we only run it (no redistribution).
RUN set -eux; \
    ARCH="$(dpkg --print-architecture)"; \
    case "$ARCH" in \
      amd64) URL=https://github.com/samueltuyizere/oc-go-cc/releases/download/v0.1.8/oc-go-cc_linux-amd64;; \
      arm64) URL=https://github.com/samueltuyizere/oc-go-cc/releases/download/v0.1.8/oc-go-cc_linux-arm64;; \
      *) echo "unsupported arch: $ARCH" >&2; exit 1;; \
    esac; \
    curl -fsSL "$URL" -o /usr/local/bin/oc-go-cc; \
    chmod +x /usr/local/bin/oc-go-cc; \
    /usr/local/bin/oc-go-cc --version || true
# GitHub CLI + Tailscale: tools the swarm uses routinely. gh auth lives in
# ~/.config/gh/ (bind-mounted, survives recreate); tailscale auth + state live
# in /var/lib/tailscale (writable layer, lost on recreate) — restored on first
# boot from /home/agent/.swarm/tailscale-backup/ by tailscale-restore.service
# below. Both packages bring their own systemd units; we don't enable tailscaled
# here because the gateway provisions the auth state (or restore does).
RUN set -eux; \
    ARCH="$(dpkg --print-architecture)"; \
    install -d -m 0755 /etc/apt/keyrings; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list; \
    # Tailscale's prebaked .list references /usr/share/keyrings/, so we place
    # the keyring there to match (mixing /etc/apt/keyrings + the upstream list
    # gives a NO_PUBKEY error at apt-get update).
    curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg \
      -o /usr/share/keyrings/tailscale-archive-keyring.gpg; \
    chmod go+r /usr/share/keyrings/tailscale-archive-keyring.gpg; \
    curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list \
      -o /etc/apt/sources.list.d/tailscale.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends gh tailscale; \
    rm -rf /var/lib/apt/lists/*; \
    tailscale --version || true; \
    gh --version || true

# Default tailscaled flags: kernel mode (uses /dev/net/tun exposed via gateway
# HostConfig + NET_ADMIN). No more userspace networking or SOCKS5 proxy —
# tailnet routing is transparent to apps now. tailscale-restore.service still
# overrides this from the agent's snapshot if one exists (so a hand-tuned
# /etc/default/tailscaled survives), but new agents come up in kernel mode.
RUN printf 'PORT="41641"\nFLAGS=""\n' > /etc/default/tailscaled

# Layer 1 (MagicDNS shim): scrape `tailscale status --json` -> /etc/hosts so
# tailnet hostnames resolve in userspace-networking mode (where 100.100.100.100
# isn't reachable from the kernel netstack). systemd timer refreshes every 5
# minutes; runs once at boot too.
COPY ts-hosts-sync.sh /usr/local/bin/ts-hosts-sync
RUN chmod +x /usr/local/bin/ts-hosts-sync
COPY ts-hosts-sync.service /etc/systemd/system/ts-hosts-sync.service
COPY ts-hosts-sync.timer /etc/systemd/system/ts-hosts-sync.timer

# Restore tailscale auth + flags from /home/agent/.swarm/tailscale-backup/ (the
# gateway snapshots state into the bind-mounted home before recreates).
COPY tailscale-restore.sh /usr/local/bin/tailscale-restore
RUN chmod +x /usr/local/bin/tailscale-restore
COPY tailscale-restore.service /etc/systemd/system/tailscale-restore.service

# Discord MCP server (outgoing actions; the receive side is the gateway bridge).
# Built to dist/ with tsc, then dev deps pruned so only the runtime deps remain.
RUN cd /opt/agent-tools/discord-mcp \
    && npm install --no-audit --no-fund \
    && npm run build \
    && npm prune --omit=dev \
    && chown -R agent:agent /opt/agent-tools/discord-mcp

# Pre-create an empty default GNOME keyring so gnome-keyring-daemon doesn't
# pop the "Choose password for new keyring" modal the first time Chrome (or
# any other app) touches the secret service. Password is blank, lock is
# disabled — fine for a single-user agent container, no real secrets stored.
RUN mkdir -p /home/agent/.local/share/keyrings \
    && printf '%s\n' \
        '[keyring]' \
        'display-name=Default' \
        'ctime=0' 'mtime=0' \
        'lock-on-idle=false' 'lock-after=false' \
        > /home/agent/.local/share/keyrings/Default.keyring \
    && echo 'Default' > /home/agent/.local/share/keyrings/default \
    && chown -R agent:agent /home/agent/.local

# Pre-accept Claude's onboarding + workspace-trust so the auto-started session
# drops straight to a usable prompt (no trust dialog). Overwrites the simpler
# seed created above; placed here so the node-pty build layer stays cached.
# (claude-config.json also registers the computer-use + discord MCP servers.)
COPY --chown=agent:agent claude-config.json /home/agent/.claude.json
# Project guide the agent reads at session start: routing prefixes (how Discord
# messages arrive) + how to reply via the discord MCP tools.
COPY --chown=agent:agent agent-claude.md /home/agent/CLAUDE.md

# statusLine command: capture Claude's status payload (model, cost, lines) to a
# file the dashboard reads, and print a concise in-TUI line. ~/.claude must be
# agent-owned so the session can write statusline.json there.
COPY swarm-statusline.sh /usr/local/bin/swarm-statusline
RUN chmod +x /usr/local/bin/swarm-statusline \
    && mkdir -p /home/agent/.claude \
    && chown -R agent:agent /home/agent/.claude
COPY --chown=agent:agent claude-settings.json /home/agent/.claude/settings.json

# Desktop toggle: drop-in conf that gates tigervnc + novnc on the absence of
# `~/.swarm/desktop-disabled`. The gateway touches that marker when the
# operator turns the desktop off in the agent settings → next systemd start
# sees the failed condition and skips. Removing the marker re-enables. We do
# this in a drop-in rather than editing the unit so distro updates can change
# the upstream unit without colliding.
RUN install -d /etc/systemd/system/tigervncserver@:1.service.d \
    && printf '[Unit]\nConditionPathExists=!/home/agent/.swarm/desktop-disabled\n' \
       > /etc/systemd/system/tigervncserver@:1.service.d/50-desktop-toggle.conf \
    && install -d /etc/systemd/system/novnc.service.d \
    && printf '[Unit]\nConditionPathExists=!/home/agent/.swarm/desktop-disabled\n' \
       > /etc/systemd/system/novnc.service.d/50-desktop-toggle.conf

# Boot to multi-user (no gdm greeter — the session comes up via TigerVNC),
# and enable our services.
RUN systemctl set-default multi-user.target \
    && systemctl enable tigervncserver@:1.service \
    && systemctl enable novnc.service \
    && systemctl enable agent-timezone.service \
    && systemctl enable agent-gpu.service \
    && systemctl enable agent-terminals.service \
    && systemctl enable tailscale-restore.service \
    && systemctl enable tailscaled.service \
    && systemctl enable ts-hosts-sync.timer \
    && (systemctl mask gdm3.service 2>/dev/null || true) \
    && echo 'DISABLE_AUTOUPDATER=1' >> /etc/environment

# No GDM means GNOME can't lock the screen and nags "Screen Lock disabled" at
# login. Disable lock/idle-blanking entirely (ephemeral agent desktops).
RUN printf '[org/gnome/desktop/screensaver]\nlock-enabled=false\nidle-activation-enabled=false\n\n[org/gnome/desktop/session]\nidle-delay=uint32 0\n\n[org/gnome/desktop/lockdown]\ndisable-lock-screen=true\n' \
      > /etc/dconf/db/local.d/01-no-screen-lock \
    && dconf update

EXPOSE 6080 7681
STOPSIGNAL SIGRTMIN+3
VOLUME [ "/sys/fs/cgroup" ]
CMD [ "/sbin/init" ]

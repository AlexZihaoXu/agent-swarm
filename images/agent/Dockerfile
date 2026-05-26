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
# TARGETARCH is populated automatically by BuildKit (amd64 / arm64). Declared
# here (not earlier) so the heavy desktop/node layers above stay cached.
ARG TARGETARCH
RUN set -eux; \
    if [ "${TARGETARCH}" = "amd64" ]; then \
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

# Make the browser usable inside a container:
#  --no-sandbox            : the userns sandbox is blocked in containers
#  --test-type             : hide the "unsupported flag" warning bar
#  --password-store=basic  : don't prompt to unlock the GNOME keyring
#  --no-first-run / --no-default-browser-check : skip first-run prompts
#  --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader :
#       software WebGL/GL via SwiftShader (no GPU in the container)
# Also suppress the TigerVNC clipboard-config window (-iconic -> -nowin).
RUN set -eux; \
    FLAGS="--no-sandbox --test-type --password-store=basic --no-first-run --no-default-browser-check --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader"; \
    if [ "${TARGETARCH}" = "amd64" ]; then \
      DESKTOP=/usr/share/applications/google-chrome.desktop; BIN=google-chrome-stable; \
    else \
      DESKTOP=/usr/share/applications/chromium.desktop; BIN=chromium; \
    fi; \
    sed -i -E "s#^Exec=(/usr/bin/)?${BIN}#Exec=\1${BIN} ${FLAGS}#" "${DESKTOP}"; \
    sed -i 's/tigervncconfig -iconic/tigervncconfig -nowin/' /etc/X11/Xtigervnc-session

# VS Code (official Microsoft apt repo — ships amd64 + arm64) and common CLI
# tools. VS Code is Electron, so it needs --no-sandbox in a container too.
RUN set -eux; \
    install -d -m 0755 /etc/apt/keyrings; \
    curl -fsSL https://packages.microsoft.com/keys/microsoft.asc \
      | gpg --dearmor -o /etc/apt/keyrings/microsoft.gpg; \
    echo "deb [arch=${TARGETARCH} signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/code stable main" \
      > /etc/apt/sources.list.d/vscode.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      code \
      ffmpeg build-essential python3-pip python3-venv pipx \
      jq unzip zip wget htop vim ripgrep imagemagick tree \
    ; \
    sed -i -E 's#^Exec=/usr/share/code/code#Exec=/usr/share/code/code --no-sandbox#' \
      /usr/share/applications/code.desktop; \
    rm -rf /var/lib/apt/lists/*

# uv — fast Python package/project manager (system-wide; installer picks the arch).
RUN curl -LsSf https://astral.sh/uv/install.sh \
    | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh

# Pin the browser (+ Files, Terminal) to the GNOME dock as default favorites,
# baked as a system dconf default so it applies to fresh agent sessions.
RUN set -eux; \
    if [ "${TARGETARCH}" = "amd64" ]; then BROWSER=google-chrome.desktop; else BROWSER=chromium.desktop; fi; \
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

# Boot-time updater that keeps Claude Code current on each container launch.
COPY claude-code-update.service /etc/systemd/system/claude-code-update.service

# Agent terminal supervisor: multi-session pty over WebSocket (node-pty + ws).
# node-pty is a native addon — build-essential + python3 (installed above) build it.
COPY runtime /opt/agent-runtime
RUN cd /opt/agent-runtime && npm install --omit=dev
COPY agent-terminals.service /etc/systemd/system/agent-terminals.service

# Pre-accept Claude's onboarding + workspace-trust so the auto-started session
# drops straight to a usable prompt (no trust dialog). Overwrites the simpler
# seed created above; placed here so the node-pty build layer stays cached.
COPY --chown=agent:agent claude-config.json /home/agent/.claude.json

# statusLine command: capture Claude's status payload (model, cost, lines) to a
# file the dashboard reads, and print a concise in-TUI line. ~/.claude must be
# agent-owned so the session can write statusline.json there.
COPY swarm-statusline.sh /usr/local/bin/swarm-statusline
RUN chmod +x /usr/local/bin/swarm-statusline \
    && mkdir -p /home/agent/.claude \
    && chown -R agent:agent /home/agent/.claude
COPY --chown=agent:agent claude-settings.json /home/agent/.claude/settings.json

# Boot to multi-user (no gdm greeter — the session comes up via TigerVNC),
# and enable our services.
RUN systemctl set-default multi-user.target \
    && systemctl enable tigervncserver@:1.service \
    && systemctl enable novnc.service \
    && systemctl enable claude-code-update.service \
    && systemctl enable agent-terminals.service \
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

#!/bin/zsh

# Finder opens .command scripts in Terminal. Work from the project folder.
cd "${0:A:h}" || exit 1
# Finder may have a different PATH from your usual shell; include common Node locations.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
# The JavaScript helper finds the LAN port and starts the bot.
node start.cjs
# Keep the window open so startup errors or disconnect messages remain readable.
printf '\nBot stopped. Press Return to close.\n'
read -r

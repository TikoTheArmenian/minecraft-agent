#!/bin/zsh
# Start the local browser control room. Use the printed URL in your browser.
cd "${0:A:h}" || exit 1
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
npm run web
printf '\nControl room stopped. Press Return to close.\n'
read -r

#!/bin/bash
# Stopt FLINT en verwijdert de achtergronddienst. De data in ./data blijft bewaard.
LABEL="com.flint.pumpbot"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "FLINT gestopt en dienst verwijderd."

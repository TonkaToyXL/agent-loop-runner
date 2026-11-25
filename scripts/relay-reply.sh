#!/usr/bin/env bash
# Send an agent's answer back to Relay. Used by webhook agents such as a Grok Bot routine.
#   relay-reply.sh <callback_url> <callback_token> <<'RELAY_ANSWER'
#   ...answer text...
#   RELAY_ANSWER
# Add --error as a third argument to report a failure instead (the text is the reason).
set -euo pipefail
URL="${1:-}"; TOKEN="${2:-}"; MODE="${3:-}"
[ -n "$URL" ] && [ -n "$TOKEN" ] || { echo "usage: relay-reply.sh <callback_url> <callback_token> [--error] < answer" >&2; exit 2; }

# Only ever post to Relay's own callback path.
case "$URL" in
  http://127.0.0.1:*/hooks/agent/*|http://localhost:*/hooks/agent/*) ;;
  *)
    PUBLIC="${RELAY_PUBLIC_URL:-}"
    if [ -z "$PUBLIC" ] || [[ "$URL" != "${PUBLIC%/}/hooks/agent/"* ]]; then
      echo "refusing to send to $URL (not a Relay callback)" >&2; exit 2
    fi ;;
esac

FIELD=result; [ "$MODE" = "--error" ] && FIELD=error
BODY="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify({[process.argv[1]]: s.trim()})))' "$FIELD")"
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST "$URL" \
  -H 'content-type: application/json' -H "x-relay-token: $TOKEN" --data-binary "$BODY")"
if [ "$CODE" = 200 ]; then echo "Delivered to Relay."; else echo "Relay answered HTTP $CODE (task may have timed out or been cancelled)." >&2; exit 1; fi

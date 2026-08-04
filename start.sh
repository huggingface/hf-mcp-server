#!/bin/sh

# Default to stdio transport if not specified
TRANSPORT="${TRANSPORT:-stdio}"
# Convert transport to lowercase for case-insensitive comparison
TRANSPORT=$(echo "$TRANSPORT" | tr '[:upper:]' '[:lower:]')
# Get port from environment or use default
PORT="${PORT:-3000}"
# For stdio mode, use HF_TOKEN as DEFAULT_HF_TOKEN if DEFAULT_HF_TOKEN is not set
if [ "$TRANSPORT" = "stdio" ] && [ -z "$DEFAULT_HF_TOKEN" ] && [ -n "$HF_TOKEN" ]; then
  export DEFAULT_HF_TOKEN="$HF_TOKEN"
fi

# Only echo if not using stdio transport
if [ "$TRANSPORT" != "stdio" ]; then
  echo "Starting MCP server with transport type: $TRANSPORT on port $PORT"

  # Check for DEFAULT_HF_TOKEN in the environment
  if [ -n "$DEFAULT_HF_TOKEN" ]; then
    echo "⚠️ DEFAULT_HF_TOKEN found in environment.  Make sure you understand the implications of this."
  else
    echo "Using standard HF_TOKEN authentication."
  fi
fi

cd packages/app

DIST_PATH="dist/server"

# Start the appropriate server based on transport type
case "$TRANSPORT" in
  stdio)
    node $DIST_PATH/stdio.js --port "$PORT"
    ;;
  streamablehttpjson)
    echo "Using streamableHttpJson transport type"
    node $DIST_PATH/streamableHttp.js --port "$PORT"
    ;;
  *)
    echo "Error: Invalid transport type '$TRANSPORT'. Valid options are: stdio, streamableHttpJson"
    exit 1
    ;;
esac

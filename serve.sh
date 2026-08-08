#!/bin/bash

# =============================================================================
# Simple HTTP Server for 3D Posters App
# =============================================================================
# This script starts a simple HTTP server to serve the app,
# since ES modules don't work with file:// protocol
# =============================================================================

PORT=8080

# Check if Python 3 is available
if command -v python3 &> /dev/null; then
    echo "Starting server with Python 3 on port $PORT"
    echo "Open your browser to: http://localhost:$PORT"
    echo "Press Ctrl+C to stop the server"
    echo ""
    python3 -m http.server $PORT
# Check if Python is available (Python 2)
elif command -v python &> /dev/null; then
    echo "Starting server with Python on port $PORT"
    echo "Open your browser to: http://localhost:$PORT"
    echo "Press Ctrl+C to stop the server"
    echo ""
    python -m SimpleHTTPServer $PORT
# Check if Node.js is available
elif command -v node &> /dev/null; then
    # Check if http-server is installed
    if npm list -g http-server &> /dev/null; then
        echo "Starting server with http-server on port $PORT"
        echo "Open your browser to: http://localhost:$PORT"
        echo "Press Ctrl+C to stop the server"
        echo ""
        npx http-server -p $PORT
    else
        echo "Installing http-server..."
        npm install -g http-server
        echo "Starting server with http-server on port $PORT"
        echo "Open your browser to: http://localhost:$PORT"
        echo "Press Ctrl+C to stop the server"
        echo ""
        npx http-server -p $PORT
    fi
# Check if PHP is available
elif command -v php &> /dev/null; then
    echo "Starting server with PHP on port $PORT"
    echo "Open your browser to: http://localhost:$PORT"
    echo "Press Ctrl+C to stop the server"
    echo ""
    php -S localhost:$PORT
else
    echo "Error: No HTTP server available."
    echo "Please install Python, Node.js, or PHP to run a local server."
    echo ""
    echo "Recommended: Install Python 3 or Node.js"
    exit 1
fi

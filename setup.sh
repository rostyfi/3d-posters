#!/bin/bash

# =============================================================================
# 3D Posters App - Setup Script
# =============================================================================
# This script prepares the TypeScript-based 3D Posters application for execution.
# It installs dependencies, builds the app, and provides usage instructions.
# =============================================================================

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored messages
print_header() {
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}========================================${NC}"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ $1${NC}"
}

# Check if we're in the correct directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
if [ ! -f "$SCRIPT_DIR/package.json" ]; then
    print_error "Please run this script from the 3d-posters project root directory."
    exit 1
fi

# Change to project directory
cd "$SCRIPT_DIR"

print_header "3D Posters App - Setup"

# Step 1: Check Node.js and npm
print_info "Checking Node.js and npm..."
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    print_success "Node.js $NODE_VERSION found"
else
    print_error "Node.js is not installed. Please install Node.js (v18+ recommended)."
    exit 1
fi

if command -v npm &> /dev/null; then
    NPM_VERSION=$(npm --version)
    print_success "npm $NPM_VERSION found"
else
    print_error "npm is not installed. Please install npm."
    exit 1
fi

# Step 2: Install dependencies
print_info "Installing dependencies..."
if [ -d "node_modules" ]; then
    print_info "Dependencies already installed. Skipping..."
else
    if npm install; then
        print_success "Dependencies installed successfully"
    else
        print_error "Failed to install dependencies"
        exit 1
    fi
fi

# Step 3: Build the application
print_info "Building the application..."
if npm run build; then
    print_success "Application built successfully"
else
    print_error "Failed to build the application"
    exit 1
fi

# Step 4: Check build output
dist_dir="dist"
if [ -d "$dist_dir" ] && [ -f "$dist_dir/index.html" ]; then
    print_success "Build output created in $dist_dir/"
else
    print_error "Build output not found in $dist_dir/"
    exit 1
fi

# Step 5: Provide usage instructions
print_header "Setup Complete!"

echo ""
print_success "3D Posters app is ready to use!"
echo ""

print_info "Available commands:"
echo ""
echo "  npm run dev      - Start development server (http://localhost:5173)"
echo "  npm run build    - Build for production"
echo "  npm run preview  - Preview production build"
echo "  npm run typecheck - Check TypeScript types without building"
echo ""
echo "  Local server for dist folder:"
echo "    python3 -m http.server 8000 --directory dist"
echo ""

print_info "To start the app in development mode:"
echo ""
echo "  $ npm run dev"
echo ""
echo "  Then open your browser to: http://localhost:5173"
echo ""

print_info "To use the production build:"
echo ""
echo "  $ npm run build"
echo "  $ npm run preview"
echo ""
echo "  Or start a local server to serve the dist folder:"
echo "    python3 -m http.server 8000 --directory dist"
echo "    Then open: http://localhost:8000"
echo ""
echo "  Or open dist/index.html directly in your browser"
echo ""

print_info "Test SVG files available:"
echo ""
echo "  - test-simple.svg"
echo "  - test-fallout.svg"
echo ""

echo ""
print_header "Ready to go!"

# Optional: Ask if user wants to start a server
# Only prompt if stdin is a terminal (interactive mode) and not a pipe
if [ -t 0 ] && [ -z "$NONINTERACTIVE" ]; then
    read -p "Would you like to start the development server now? (y/N): " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        print_info "Starting development server..."
        echo "Press Ctrl+C to stop the server"
        echo ""
        npm run dev
    else
        read -p "Would you like to start a production server on port 8000? (y/N): " -n 1 -r
        echo ""
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            print_info "Starting production server on http://localhost:8000..."
            echo "Press Ctrl+C to stop the server"
            echo ""
            cd dist && python3 -m http.server 8000 --directory .
        fi
    fi
else
    print_info "Running non-interactively. Skipping server startup prompts."
    print_info "To start a server manually:"
    echo "  npm run dev          - Development server"
    echo "  python3 -m http.server 8000 --directory dist  - Production server"
fi
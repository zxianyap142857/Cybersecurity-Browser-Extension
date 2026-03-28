#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

ENV_NAME="venv"
REQUIREMENTS_FILE="requirements.txt"

# 1. Create a virtual environment
echo "Creating virtual environment named '$ENV_NAME'..."
python3 -m venv $ENV_NAME

# 2. Activate the virtual environment
# The activation command differs slightly based on the shell. 
# For this script, we'll source the activate script for bash/sh.
echo "Activating the virtual environment..."
source $ENV_NAME/bin/activate

# 3. Install packages from requirements.txt
if [ -f "$REQUIREMENTS_FILE" ]; then
    echo "Installing packages from $REQUIREMENTS_FILE..."
    pip install -r $REQUIREMENTS_FILE
else
    echo "Error: $REQUIREMENTS_FILE not found."
    exit 1
fi

echo "Installation complete. Virtual environment '$ENV_NAME' is ready."
echo "To activate it in a new terminal, run: source $ENV_NAME/bin/activate"

# Deactivate the environment after the script finishes
deactivate

#!/bin/bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if version type argument is provided
if [ -z "$1" ]; then
  echo -e "${RED}Error: Version type argument is required${NC}"
  echo "Usage: ./release.sh <patch|minor|major>"
  exit 1
fi

VERSION_TYPE=$1

# Validate version type
if [[ ! "$VERSION_TYPE" =~ ^(patch|minor|major)$ ]]; then
  echo -e "${RED}Error: Invalid version type '$VERSION_TYPE'${NC}"
  echo "Valid options: patch, minor, major"
  exit 1
fi

# Check for uncommitted changes
if [[ -n $(git status --porcelain) ]]; then
  echo -e "${RED}Error: You have uncommitted changes. Please commit or stash them first.${NC}"
  exit 1
fi

echo -e "${YELLOW}Starting release process...${NC}"

# Step 1: Run lint
echo -e "${YELLOW}Running lint...${NC}"
bun run lint
echo -e "${GREEN}Lint passed!${NC}"

# Step 2: Run tests
echo -e "${YELLOW}Running tests...${NC}"
bun test
echo -e "${GREEN}Tests passed!${NC}"

# Step 3: Bump version
echo -e "${YELLOW}Bumping $VERSION_TYPE version...${NC}"

# Get current version from package.json
CURRENT_VERSION=$(bun -e "console.log(require('./package.json').version || '0.0.0')")

# Calculate new version
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

case $VERSION_TYPE in
  patch)
    PATCH=$((PATCH + 1))
    ;;
  minor)
    MINOR=$((MINOR + 1))
    PATCH=0
    ;;
  major)
    MAJOR=$((MAJOR + 1))
    MINOR=0
    PATCH=0
    ;;
esac

NEW_VERSION="$MAJOR.$MINOR.$PATCH"
echo -e "${GREEN}Version: $CURRENT_VERSION -> $NEW_VERSION${NC}"

# Update version in package.json
bun -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
pkg.version = '$NEW_VERSION';
fs.writeFileSync('./package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# Step 4: Build the project
echo -e "${YELLOW}Building project...${NC}"
bun run build
echo -e "${GREEN}Build completed!${NC}"

# Step 5: Commit new version
echo -e "${YELLOW}Committing version bump...${NC}"
git add package.json
git commit -m "chore(release): v$NEW_VERSION"
echo -e "${GREEN}Committed!${NC}"

# Step 6: Tag the commit
echo -e "${YELLOW}Creating git tag v$NEW_VERSION...${NC}"
git tag "v$NEW_VERSION"
echo -e "${GREEN}Tag created!${NC}"

# Step 7: Publish to npm
echo -e "${YELLOW}Publishing to npm...${NC}"
npm publish --access public
echo -e "${GREEN}Published to npm!${NC}"

# Push commits and tags
echo -e "${YELLOW}Pushing to remote...${NC}"
git push && git push --tags
echo -e "${GREEN}Pushed to remote!${NC}"

echo -e "${GREEN}Release v$NEW_VERSION completed successfully!${NC}"

#!/bin/sh
# Print the package version, derived from the current commit.
#
# The version is the commit date as YYYY.MM.DD. The date comes from the commit
# itself, so the result does not depend on the build host's timezone or on how
# much history was fetched.
#
# Exits non-zero when the tree has no git metadata; the Makefile then falls
# back to its default constant.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)

git -C "$root" rev-parse --git-dir >/dev/null 2>&1 || exit 1

git -C "$root" log -1 --date=format:%Y.%m.%d --format=%cd

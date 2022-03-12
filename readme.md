<!--
Copyright 2022 leorize <leorize+oss@disroot.org>

SPDX-License-Identifier: GPL-3.0-only
-->

# Setup Nimskull

An action for setting up the Nimskull environment for use within Github Actions.
Currently, the action does the following:

- Download and install a version of nimskull according to given spec and add it
  to `PATH`.

- Register problem matchers for error outputs.

# Usage

See [action.yml](action.yml) for all supported inputs and outputs.

```yaml
# Copyright 2022 leorize <leorize+oss@disroot.org>
#
# SPDX-License-Identifier: CC0-1.0

steps:
  - uses: actions/checkout@v3
  - uses: alaviss/setup-nimskull@main
    with:
      nimskull-version: '*' # The nimskull version to download, supports semver specification
```

# License

Unless stated otherwise, scripts and documentations within this project are
released under the [GNU GPLv3 license](license.txt).

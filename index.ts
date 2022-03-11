/*
 * Copyright 2022 leorize <leorize+oss@disroot.org>
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

import * as core from '@actions/core';
import * as gh from '@actions/github';
import * as tc from '@actions/tool-cache';
import * as searcher from './searcher.ts';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { Octokit } from '@octokit/core';

/**
 * The name of the tool being setup.
 */
const ToolName = 'nimskull';

/**
 * Entry point for the script
 */
async function setup() {
  try {
    const octokit = gh.getOctokit(core.getInput('token'));
    const version = core.getInput('nimskull-version');
    const update = core.getBooleanInput('check-latest');

    setupCompiler(octokit, version, update);
  } catch (error: any) {
    core.setFailed(error.message);
  }
}

/**
 * Download and setup the compiler, as well as setting outputs for the action.
 *
 * @param client - The Octokit client used to download release data
 * @param range - The semver range to match against
 * @param update - Whether to update the compiler to the latest version if available.
 */
async function setupCompiler(client: Octokit, range: string, update: boolean) {
  /* Check to see if the requested version is in the cache */
  let installDir = tc.find(ToolName, range);

  /* If its not in the cache or an update is requested */
  if (!installDir || update) {
    const matchedVersion = await searcher.findVersion(client, range);
    if (!matchedVersion)
      throw `Could not find any release matching the specification: ${range}`;
    core.info(`Latest version matching specification: ${matchedVersion}`);

    installDir = tc.find(ToolName, matchedVersion);
    /* If this version is not in the cache, download and install it */
    if (!installDir) {
      core.info(`Version ${matchedVersion} is not cached, downloading`);
      const url = await searcher.getDownloadUrl(client, matchedVersion);
      if (!url)
        throw `There are no prebuilt binaries for the current platform.`

      const downloadPath = await tc.downloadTool(url);
      const extracted = downloadPath.endsWith('.zip') ?
                        await tc.extractZip(downloadPath) :
                        /* Make tar detects the compression type instead of
                         * defaulting to gzip */
                        await tc.extractTar(downloadPath, undefined, ['xa']);

      /* The archive consist of one top-level folder, which contains the
       * compiler and tools. */
      const files = await fs.readdir(extracted);
      if (files.length !== 1)
        throw `Expected 1 folder in extracted archive but got ${files.length}`;

      const actualCompilerDir = path.join(
        extracted,
        /* Get the first (and only) directory name inside the extracted
         * archive. */
        files[0]!
      );

      installDir = await tc.cacheDir(
        actualCompilerDir,
        ToolName,
        matchedVersion
      )
      core.info(`Added ${matchedVersion} to cache`);
    }
  }

  const { version, commit } = JSON.parse(
    await fs.readFile(path.join(installDir, 'release.json'), { encoding: 'utf8' })
  );

  const binDir = path.join(installDir, 'bin');
  core.addPath(binDir);

  core.setOutput('path', installDir);
  core.setOutput('binPath', binDir);
  core.setOutput('version', version);
  core.setOutput('commit', commit);
}

setup();

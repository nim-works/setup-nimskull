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
import * as os from 'os';
import * as exec from '@actions/exec';
import { v4 as uuidgen } from 'uuid';
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

    await setupCompiler(octokit, version, update);
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
    const release = await searcher.findVersion(client, range)
    if (!release)
      throw `Could not find any release matching the specification: ${range}`;
    core.info(`Latest version matching specification: ${release.tag}`);

    installDir = tc.find(ToolName, release.tag);
    /* If this version is not in the cache, download and install it */
    if (!installDir) {
      core.info(`Version ${release.tag} is not cached, downloading`);
      const url = await searcher.getDownloadUrl(client, release.id);
      if (!url)
        throw `There are no prebuilt binaries for the current platform.`

      const compilerDir = await downloadAndExtractCompiler(url);

      installDir = await tc.cacheDir(
        compilerDir,
        ToolName,
        release.tag
      )
      core.info(`Added ${release.tag} to cache`);
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

/**
 * Download and extract the compiler
 *
 * @param url - The URL to download compiler from. Assumed to be a Github download URL.
 * @return The extracted compiler directory.
 */
async function downloadAndExtractCompiler(url: string): Promise<string> {
  const downloaded = await tc.downloadTool(url);

  let result = '';
  if (url.endsWith('.zip'))
    result = await tc.extractZip(downloaded);
  else {
    const tarFile = path.join(process.env['RUNNER_TEMP'] || os.tmpdir(), uuidgen());

    /* Un-zstd the archive manually as some tar versions doesn't support zstd */
    await exec.exec('unzstd', [downloaded, '-o', tarFile])
    result = await tc.extractTar(tarFile, undefined, ['x']);
  }

  /* The archive consist of one top-level folder, which contains the
   * compiler and tools. */
  const files = await fs.readdir(result);
  if (files.length !== 1)
    throw `Expected 1 folder in extracted archive but got ${files.length}`;

  /* Set that folder as the result */
  result = path.join(result, files[0]!);

  return result
}

setup();

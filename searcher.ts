/*
 * Copyright 2022 leorize <leorize+oss@disroot.org>
 *
 * SPDX-License-Identifier: MIT
 */

/**
 * Implements a simple searcher for a nimskull release via Github Release.
 */

import * as semver from 'semver';
import * as os from 'os';
import { HttpClient, HttpCodes } from '@actions/http-client';
import type { Octokit } from '@octokit/core';

const DefaultRepo = 'nim-works/nimskull';
const SupportedManifestVersion = 0;

interface ArtifactDataV0 {
  name: string;
  sha256: string;
}

interface BinaryArtifactDataV0 extends ArtifactDataV0 {
  target: string;
}

interface ReleaseManifestV0 {
  manifestVersion: number;
  version: string;
  source: ArtifactDataV0;
  binaries: BinaryArtifactDataV0[];
}

/**
 * A release description
 */
export interface Release {
  /**
   * The UID of the release. This can be passed to Github to obtain more data.
   */
  id: string;
  /**
   * The tag of the release. For nimskull this is also the version
   */
  tag: string;
}

/**
 * Find the latest nimskull release matching the specified range.
 *
 * Pre-releases are included, as the project does not have any stable release
 * at the moment.
 *
 * @param client - The Octokit client used to interact with Github.
 * @param range - The semver range to match against.
 * @param repo - The repository to fetch versions from.
 *
 * @return The latest release matching the range. Null is returned if such
 *         version is not found.
 */
export async function findVersion(client: Octokit, range: string, repo = DefaultRepo): Promise<Release | null> {
  for await (const release of getReleases(client, repo)) {
    if (semver.satisfies(release.tag, range, { includePrerelease: true }))
      return release;
  }

  return null;
}

/**
 * Retrieve the compiler binary download link for the current system.
 *
 * @param client - The Octokit client used to interact with Github.
 * @param releaseId - The unique release id to download binaries for.
 *
 * @return The link to download the binary for the current system, null if not available.
 */
export async function getDownloadUrl(client: Octokit, releaseId: string): Promise<string | null> {
  const manifestReq = await (new HttpClient()).get(
    await urlForAsset(client, releaseId, "manifest.json")
  );

  if (manifestReq.message.statusCode != HttpCodes.OK)
    throw `Fetching release manifest failed with status code: ${manifestReq.message.statusCode}`;

  const manifest: ReleaseManifestV0 = JSON.parse(await manifestReq.readBody());
  if (manifest.manifestVersion != SupportedManifestVersion)
    throw `Expected manifest version ${SupportedManifestVersion} but got ${manifest.manifestVersion}`;

  const targetBinary = manifest.binaries.find(x => tripletMatchesSystem(x.target));
  if (targetBinary)
    return await urlForAsset(client, releaseId, targetBinary.name);

  return null;
}

/**
 * Retrieve the URL for a particular Github Release Asset.
 *
 * @param client - The Octokit client used to interact with Github.
 * @param id - The release unique id.
 * @param asset - The exact name of the asset.
 *
 * @return The URL of the requested asset if it exists.
 */
async function urlForAsset(client: Octokit, id: string,
                           asset: string): Promise<string> {
  const {
    node: {
      releaseAssets: {
        nodes: [
          {
            downloadUrl
          }
        ]
      }
    }
  } = await client.graphql(
    `
      query ($id: ID!, $assetName: String!) {
        node(id: $id) {
          ... on Release {
            releaseAssets(first: 1, name: $assetName) {
              nodes {
                downloadUrl
              }
            }
          }
        }
      }
    `,
    {
      id: id,
      assetName: asset
    }
  );

  return downloadUrl || null;
}

/**
 * @param triplet - The triplet to check. See
 *        https://clang.llvm.org/docs/CrossCompilation.html#target-triple
 *        for the format.
 *
 * @return Whether the given triplet describes the current system.
 *         This only covers targets that are likely to be run in CI.
 */
function tripletMatchesSystem(triplet: string): boolean {
  if (!triplet)
    return false;

  const splitted = triplet.split('-');

  /* If the architecture part is not defined, the triplet is invalid */
  if (!splitted[0])
    return false;

  /* Process architecture */
  switch (os.arch()) {
    case 'arm':
      if (!splitted[0].match(/arm/))
        return false;
      break;
    case 'arm64':
      if (splitted[0] !== 'aarch64')
        return false;
      break;
    case 'x64':
      if (splitted[0] !== 'x86_64')
        return false;
      break;
    default:
      /* If it's an architecture that we do not know of, assume that the
       * triplet did not match */
      return false;
  }

  let scanPos = 1;
  if (scanPos < splitted.length) {
    /* Process vendor */
    switch (splitted[scanPos]) {
      case 'pc':
        /* Assume Darwin to be the macOS runner, which should match against
         * 'apple' vendor */
        if (os.platform() === 'darwin')
          return false;
        scanPos++;
        break;
      case 'apple':
        if (os.platform() !== 'darwin')
          return false;
        scanPos++;
        break;
    }

    /* Process OS */
    switch (splitted[scanPos]) {
      case 'darwin':
      case 'macosx':
        if (os.platform() !== 'darwin')
          return false;
        scanPos++;
        break;
      case 'linux':
        if (os.platform() !== 'linux')
          return false;
        scanPos++;
        /* Process environment (if any), accept only the version using GNU ABI */
        if (splitted[scanPos])
          if (!splitted[scanPos]!.match(/gnu/))
            return false;
        break;
      case 'windows':
        if (os.platform() !== 'win32')
          return false;
        scanPos++;
        /* Process environment (if any), accept only the version using GNU ABI */
        if (splitted[scanPos])
          if (!splitted[scanPos]!.match(/gnu/))
            return false;
        break;
    }
  }

  return true;
}

/**
 * Iterates through all releases in the given repository, from most to least recent.
 *
 * @param client - The authenticated octokit client.
 * @param repo - The repository to obtain release data from.
 *
 * @return The release tag name.
 */
async function* getReleases(client: Octokit, repo: String): AsyncGenerator<Release> {
  const [ owner, name ] = repo.split('/');

  let hasNextPage = false;
  do {
    let endCursor = null;
    const {
      repository: {
        releases: {
          edges: releaseEdges,
          pageInfo
        }
      }
    } = await client.graphql(
      `
        query ($owner: String!, $name: String!, $endCursor: String, $order: ReleaseOrder!) {
          repository(owner: $owner, name: $name) {
            releases(after: $endCursor, last: 10, orderBy: $order) {
              edges {
                node {
                  tagName
                }
              }

              pageInfo {
                endCursor
                hasNextPage
              }
            }
          }
        }
      `,
      {
        owner: owner,
        name: name,
        endCursor: endCursor,
        order: {
          direction: 'DESC',
          field: 'CREATED_AT'
        }
      }
    );

    ({ endCursor, hasNextPage } = pageInfo);

    for (const { node: { id, tagName } } of releaseEdges) {
      yield {id: id, tag: tagName};
    }
  } while (hasNextPage);
}

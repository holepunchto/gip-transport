# Gip Transport

Git remote helper for P2P remotes — no server, just peers.

Uses [gip-remote](https://github.com/holepunchto/gip-remote) for the underlying Git-in-Pear database.

## Installation

Install self-updating standalone binaries with [`pear`](https://install.pears.com):

```bash
pear install pear://gipjk71nbuj3zasm4ywczb93zqk5xbfup16c6d5j8w8yeja4ob6o
```

Or via `npx`:

```bash
npx pear-install pear://gipjk71nbuj3zasm4ywczb93zqk5xbfup16c6d5j8w8yeja4ob6o
```

This installs standalone binary executables;
`%LOCALAPPDATA%\\Programs\\gip\\gip.exe`, `%LOCALAPPDATA%\\Programs\\gip\git+pear` and `%LOCALAPPDATA%\\Programs\\gip\\git-remote-git+pear` on Windows else `~/.local/bin/gip`, `~/.local/bin/git+pear` and `~/.local/bin/git-remote-git+pear` on MacOS and Linux.

Manual install is also easy, download from [./releases](./releases) and move to the relevant folder. On MacOS and Linux the `$PATH` may also need to updated to point at `~/.local/bin`.

Exectuables are evergreen and receive P2P OTA updates.

**Alternatively** it can also be installed as a global npm package:

```bash
npm i -g gip-transport
```

This installs `gip`, `git+pear` and `git-remote-git+pear` as an npm package which **does not** receive peer-to-peer OTA updates and requires `node` to be on the system.

## Usage

### Creating a Repository

```bash
gip new my-repo
```

### Adding a Remote

```bash
git remote add origin git+pear://<key>/my-repo
```

### Push & Fetch

Works like any git remote:

```bash
git push origin main
git fetch origin
git clone git+pear://<key>/my-repo
git push origin --delete my-branch
```

### Seeding

Keep your repositories available to peers:

```bash
gip seed
```

Prints your public key and lists the repositories being seeded. Logs peer connections and block transfers as they happen:

```
Seeding — Public key: 38ue8c5euscbjm8cqhan7psmgx9jpji5iey9aqjzf84749ghoqpo

  my-repo — 42 blocks

+ Peer connected 7xk9m3f2
  ↑ my-repo block 0 → 7xk9m3f2
  ↑ my-repo block 1 → 7xk9m3f2
```

### peer-to-peer `npm install` dependencies

Opt-in to `npm` installed peer-to-peer git dependencies with the following lines in a project `.npmrc`:

```js
git=git+pear
allow-git=all
```

This unlocks installation of git repositories seeded with `gip` using the following syntax:

```sh
npm install git+file://pear/<key>/<name>
```

`git+pear://` is not a recognized as a link by `npm`, however `git=git+pear` in `.npmrc` tells `npm` to use the `git+pear` binary instead of `git`. The `git+pear` executable spawns `git` with the following environment variables set:

```js
  GIT_CONFIG_COUNT=2
  GIT_CONFIG_KEY_0=url.git+pear://.insteadOf
  GIT_CONFIG_VALUE_0=file://pear/
  GIT_CONFIG_KEY_1=protocol.git+pear.allow
  GIT_CONFIG_VALUE_1=always
```

This instructs `git` to map `git+file://pear` to `git+pear://`.

The `file://[host]/<...pathname>` protocol typically has no host specified because it usually refers to the local filesystem: `file:///some/path`. When the host is specified, it's indicating a remote path; `file://pear/<key>/<name>` indicates the `/<key>/<name>` path is remote via pear.

Example:

```sh
npm install git+file://pear/z17anrqrtwgjxpig3oiohoxr7m9eijz3acpytiay6xku8pdh68by/foo
```

The `.npmrc` file tells `npm` to execute `git+pear` with `git+file://pear/z17anrqrtwgjxpig3oiohoxr7m9eijz3acpytiay6xku8pdh68by/foo` which tells `git` to `git+pear://z17anrqrtwgjxpig3oiohoxr7m9eijz3acpytiay6xku8pdh68by/foo` which results in `npm` effectively executing `git clone git+pear://z17anrqrtwgjxpig3oiohoxr7m9eijz3acpytiay6xku8pdh68by/foo` in the install process.

This adds `git+file://pear/z17anrqrtwgjxpig3oiohoxr7m9eijz3acpytiay6xku8pdh68by/foo` to the `package.json` dependencies and will always install the latest.

Unlike other `git` links `git+pear` can be immutably addressed so the following example would install the exact same contents every time:

```sh
npm install git+file://pear/0.32.z17anrqrtwgjxpig3oiohoxr7m9eijz3acpytiay6xku8pdh68by/foo
```

This would add `"foo": "file://pear/0.32.z17anrqrtwgjxpig3oiohoxr7m9eijz3acpytiay6xku8pdh68by/foo"` to the `package.json` effectively pinning the version based on the immutable log fork and length.

### Your Public Key

Print your public key to share with blind peer operators:

```bash
gip id
```

## Configuration

Configuration is stored in the local HyperDB database.

### Blind Peers

Blind peers relay your data for discoverability without seeing its contents. Add a blind peer mirror:

```bash
gip config add blind-peers <z32-key>
```

Remove one:

```bash
gip config remove blind-peers <z32-key>
```

View current config:

```bash
gip config
gip config get blind-peers
```

### Storage

Everything gip keeps on disk — the corestore, the local database and the
updater's staging area — lives under `~/.gip`. Point the CLI somewhere else with
`--storage`:

```bash
gip --storage /tmp/scratch list
```

The remote helper takes the same directory from the remote URL:

```bash
git remote add origin 'git+pear://<key>/my-repo?storage=/tmp/scratch'
```

### Progress Output

The transport provides git-like progress output during push and fetch operations:

- **Enumerating objects**: Counts objects being prepared for transfer
- **Writing objects**: Shows percentage complete, object count, data size, and transfer rate
- **Receiving objects**: Similar progress for fetch/clone operations

Progress is written to stderr to avoid interfering with git protocol communication on stdout.

## Build

`npm run make` builds both binaries for the host:

```bash
npm run make
```

Or one at a time:

```bash
npm run make:gip
npm run make:git-remote-git+pear
```

Each of those runs the matching `make:<bin>:<host>` script, which is a plain
`bare-build` invocation. `out/` comes out as a ready-to-stage deployment
folder:

```
out/
  package.json
  by-arch/
    darwin-arm64/
      app/
        gip
        git-remote-git+pear
```

## Pear Deployment

When a SemVer git tag is pushed to the repo, GitHub workflows creates builds and pushes them to releases as a tarball.

The tarball is downloaded & extracted (`sh scripts/get-releases`) and then deployed with `pear`.

Given the following example deployment links:

- staging - pear://spmwyi6994m355axjob57j6ihguek4dsdujyzhxuaktm4tjjye4y
- prerelease - pear://766j3rsfbf1oqugswzianawqkdtbdzug98ybhk69gt79syf3yfby
- production - pear://gipxpdn4dikq6j4n1bokfu5r36n1b8d6cd5e68jj396uz7m56r3y

Each must be seeded (`pear seed <link>`).

Stage to staging

```
pear stage pear://spmwyi6994m355axjob57j6ihguek4dsdujyzhxuaktm4tjjye4y
```

Once staging is verified provision to prerelease

```
pear provision pear://0.8.spmwyi6994m355axjob57j6ihguek4dsdujyzhxuaktm4tjjye4y pear://766j3rsfbf1oqugswzianawqkdtbdzug98ybhk69gt79syf3yfby pear://0.3.gipxpdn4dikq6j4n1bokfu5r36n1b8d6cd5e68jj396uz7m56r3y
```

This synchonronizes from the versioned production link (pear://0.3.gip..) to the target prerelease link (pear://766j3...), then sychronizes from the staging versioned link (pear://0.8.spmw) to the target prerelease link.

Versioned links take the form `pear://<fork>.<length>.<key>`. `pear info pear://<key>` has the versioned link in its output.

Once prerelease is confirmed as working create a multisig request from the prerelease link, versioned:

```
pear multisig request pear://0.10.766j3rsfbf1oqugswzianawqkdtbdzug98ybhk69gt79syf3yfby
```

Quorum members can then sign:

```
pear multisig sign ycyywyns9jihji9j9x4qcbqgjsssth83qudi8u1t53ugrmq1rxufwstj6eyoyyybyeyy64j3ci6yjxat134ju36mq19ox165pamrrehhffr7xdbiqhc7ntz3jspu3qfw9mtiwstpdks1g6s9fwjhfkiribfrxxzsjd8ttga59hyy64j3ci6yjxat134ju36mq19ox165pamrrehhffr7xdbiqhc7nt1p3uo8ass4x9rwxuqjtjewbrgnu1b9rm8k5pwmi1fgizsj7wbu3ay95kebz66h89e36wbr1g1167udcg9x665rgo3qxrjwm1wmwzdsu8qbgieo
```

Once collected signatures should be verified:

```
pear multisig verify pear://766j3rsfbf1oqugswzianawqkdtbdzug98ybhk69gt79syf3yfby ycyywyns9jihji9j9x4qcbqgjsssth83qudi8u1t53ugrmq1rxufwstj6eyoyyybyeyy64j3ci6yjxat134ju36mq19ox165pamrrehhffr7xdbiqhc7ntz3jspu3qfw9mtiwstpdks1g6s9fwjhfkiribfrxxzsjd8ttga59hyy64j3ci6yjxat134ju36mq19ox165pamrrehhffr7xdbiqhc7nt1p3uo8ass4x9rwxuqjtjewbrgnu1b9rm8k5pwmi1fgizsj7wbu3ay95kebz66h89e36wbr1g1167udcg9x665rgo3qxrjwm1wmwzdsu8qbgieo ycys1f584hzwit7z1twff4qigw9wsewby5i9g7etkoy7ccoid7goty4p3uo8ass3x7rwxuqjtjewbrgnu1b9rm8k5pwmi1fgizsj7wbu3abyzrdg38eqwum3ntnzxkc5rn77gqdt6s7ifkfnqi8qahu8jqdb7wbp6nwh5xenuqat1fbw16t8bsxkbeqfajrdgsyhxz49a3wwz3ndbq341hetbus6mcw8e56yt5fuun61nmo59jwp16nzxijmyzi93c3cxx6ctf11xxrqsj3izi48mmnxpfurut96q3hz9z3prdytbdnbx8op
```

Once all signaturues are collected and verified, multisig commit them to proceed to production:

```
pear multisig commit pear://766j3rsfbf1oqugswzianawqkdtbdzug98ybhk69gt79syf3yfby ycyywyns9jihji9j9x4qcbqgjsssth83qudi8u1t53ugrmq1rxufwstj6eyoyyybyeyy64j3ci6yjxat134ju36mq19ox165pamrrehhffr7xdbiqhc7ntz3jspu3qfw9mtiwstpdks1g6s9fwjhfkiribfrxxzsjd8ttga59hyy64j3ci6yjxat134ju36mq19ox165pamrrehhffr7xdbiqhc7nt1p3uo8ass4x9rwxuqjtjewbrgnu1b9rm8k5pwmi1fgizsj7wbu3ay95kebz66h89e36wbr1g1167udcg9x665rgo3qxrjwm1wmwzdsu8qbgieo ycys1f584hzwit7z1twff4qigw9wsewby5i9g7etkoy7ccoid7goty4p3uo8ass3x7rwxuqjtjewbrgnu1b9rm8k5pwmi1fgizsj7wbu3abyzrdg38eqwum3ntnzxkc5rn77gqdt6s7ifkfnqi8qahu8jqdb7wbp6nwh5xenuqat1fbw16t8bsxkbeqfajrdgsyhxz49a3wwz3ndbq341hetbus6mcw8e56yt5fuun61nmo59jwp16nzxijmyzi93c3cxx6ctf11xxrqsj3izi48mmnxpfurut96q3hz9z3prdytbdnbx8op
```

## Updates

Each standalone binary updates itself: the updater mirrors
`by-arch/<host>/app/<its own filename>` out of the upgrade drive and swaps it
over the running executable, which is why all three are built into one drive.

Updates run alongside the long-lived operations, where a download has time to
land: `gip seed` keeps the updater alive for as long as it runs, and the remote
helper keeps it alive for the duration of a fetch or push. Short CLI commands
skip it entirely; a partial download stays in the store and resumes next time.

To opt out:

```bash
gip --no-updates seed       # one run of the CLI
GIP_NO_UPDATES=1 git push   # the remote helper
```

## Development

Run the CLI from source:

```bash
npm start
```

Link the remote helper so git can find it:

```bash
sudo ln -s $(pwd)/bin.js /usr/local/bin/git-remote-git+pear
```

Git automatically looks for `git-remote-<protocol>` when accessing a remote.

## ToDo

- [ ] Multi-signer
- [x] Deduplication — objects are not pushed if they already exist on the remote
- [x] In-memory git packing via rebuild-git
- [x] Blind peer support
- [x] Branch deletion

<!-- Reference Links -->

[bare]: https://github.com/holepunchto/bare
[pear-docs]: https://docs.pears.com
[hello-pear-bare]: https://github.com/holepunchto/hello-pear-bare

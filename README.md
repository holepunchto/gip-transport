# Gip Transport

Git remote helper for P2P remotes — no server, just peers.

Uses [gip-remote](https://github.com/holepunchto/gip-remote) for the underlying Git-in-Pear database.

## Installation

**Either** install self-updating standalone binaries with [`pear`](https://install.pears.com):

```bash
pear install pear://giptjafc48q59iz884dpax66d7gdnym6a1efpx7uztza1a88iz6o
```

**Or** gip can also be installed peer-to-peer as a self-updating standalone binary with `npx`:

```bash
npx gip-transport
```

**Alternatively** it can be installed as an npm exectuable (which **does not** receive peer-to-peer OTA updates):

```bash
npm i -g gip-transport
```

Whichever approach is used, this installs `git-remote-git+pear` which git will automatically use when accessing `git+pear://` remotes, and the `gip` CLI for managing repositories and configuration.

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

`npm run make` builds all three binaries for the host:

```bash
npm run make
```

Or one at a time:

```bash
npm run make:gip
npm run make:git-pear
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
        git-pear
        git-remote-git+pear
```

## Pear Deployment

When a SemVer git tag is pushed to the repo, GitHub workflows creates builds and pushes them to releases as a tarball.

The tarball is downloaded & extracted (`sh scripts/get-releases`) and then deployed with `pear`.

```
pear stage pear://spmwyi6994m355axjob57j6ihguek4dsdujyzhxuaktm4tjjye4y
```

```
pear provision pear://0.8.spmwyi6994m355axjob57j6ihguek4dsdujyzhxuaktm4tjjye4y pear://766j3rsfbf1oqugswzianawqkdtbdzug98ybhk69gt79syf3yfby pear://0.3.swapb14acos6iasoz5jg8bj46zt8emdk9rmm4n9j18mtjmwbqmwo
```

```
pear multisig request pear://0.10.766j3rsfbf1oqugswzianawqkdtbdzug98ybhk69gt79syf3yfby
```

```
pear multisig sign ycyywyns9jihji9j9x4qcbqgjsssth83qudi8u1t53ugrmq1rxufwstj6eyoyyybyeyy64j3ci6yjxat134ju36mq19ox165pamrrehhffr7xdbiqhc7ntz3jspu3qfw9mtiwstpdks1g6s9fwjhfkiribfrxxzsjd8ttga59hyy64j3ci6yjxat134ju36mq19ox165pamrrehhffr7xdbiqhc7nt1p3uo8ass4x9rwxuqjtjewbrgnu1b9rm8k5pwmi1fgizsj7wbu3ay95kebz66h89e36wbr1g1167udcg9x665rgo3qxrjwm1wmwzdsu8qbgieo
```

```
pear multisig verify pear://766j3rsfbf1oqugswzianawqkdtbdzug98ybhk69gt79syf3yfby ycyywyns9jihji9j9x4qcbqgjsssth83qudi8u1t53ugrmq1rxufwstj6eyoyyybyeyy64j3ci6yjxat134ju36mq19ox165pamrrehhffr7xdbiqhc7ntz3jspu3qfw9mtiwstpdks1g6s9fwjhfkiribfrxxzsjd8ttga59hyy64j3ci6yjxat134ju36mq19ox165pamrrehhffr7xdbiqhc7nt1p3uo8ass4x9rwxuqjtjewbrgnu1b9rm8k5pwmi1fgizsj7wbu3ay95kebz66h89e36wbr1g1167udcg9x665rgo3qxrjwm1wmwzdsu8qbgieo ycys1f584hzwit7z1twff4qigw9wsewby5i9g7etkoy7ccoid7goty4p3uo8ass3x7rwxuqjtjewbrgnu1b9rm8k5pwmi1fgizsj7wbu3abyzrdg38eqwum3ntnzxkc5rn77gqdt6s7ifkfnqi8qahu8jqdb7wbp6nwh5xenuqat1fbw16t8bsxkbeqfajrdgsyhxz49a3wwz3ndbq341hetbus6mcw8e56yt5fuun61nmo59jwp16nzxijmyzi93c3cxx6ctf11xxrqsj3izi48mmnxpfurut96q3hz9z3prdytbdnbx8op
```

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

### Scripts

- `npm start` — run the CLI under bare with updates disabled
- `npm test` — run the brittle-bare test suite
- `npm run lint` — lunte and prettier check
- `npm run format` — format with prettier
- `npm run make` — build all three binaries for the host
- `npm run make:<bin>` — build one of the `bin` entries in package.json
- `npm run make:<bin>:<host>` — the underlying `bare-build` invocation
- `npm run clean` — remove `out/`

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

# Gip Transport

Git remote helper for P2P remotes — no server, just peers.

Uses [gip-remote](https://github.com/holepunchto/gip-remote) for the underlying Git-in-Pear database.

## Installation

Install the git remote helper globally:

```bash
npm i -g gip-transport
```

This installs `git-remote-git+pear` which git will automatically use when accessing `git+pear://` remotes, and the `gip` CLI for managing repositories and configuration.

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

### Progress Output

The transport provides git-like progress output during push and fetch operations:

- **Enumerating objects**: Counts objects being prepared for transfer
- **Writing objects**: Shows percentage complete, object count, data size, and transfer rate
- **Receiving objects**: Similar progress for fetch/clone operations

Progress is written to stderr to avoid interfering with git protocol communication on stdout.

## Development

Link the remote helper so git can find it:

```bash
sudo ln -s $(pwd)/remote.js /usr/local/bin/git-remote-git+pear
```

Git automatically looks for `git-remote-<protocol>` when accessing a remote.

## ToDo

- [ ] Multi-signer
- [x] Deduplication — objects are not pushed if they already exist on the remote
- [x] In-memory git packing via rebuild-git
- [x] Blind peer support
- [x] Branch deletion

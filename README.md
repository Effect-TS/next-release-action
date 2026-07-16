# Next Release Action

A GitHub Action for managing staged release branches and pull requests from changesets.

## Usage

```yaml
- uses: Effect-TS/next-release-action@main
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
```

Optional inputs include `packages`, `branch_prefix`, `base_branch`, `git_user`, and `git_email`.

## Development

```sh
vp install
vp check
vp test
vp pack
```

## License

MIT

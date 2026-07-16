# Next Release Action

A GitHub Action for managing staged release branches and pull requests from changesets.

## Usage

```yaml
- uses: Effect-TS/next-release-action@main
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
```

Optional inputs include `packages`, `eligible_branches`, `branch_prefix`, `base_branch`, `git_user`, and
`git_email`. `eligible_branches` defaults to `<branch_prefix>-minor,<branch_prefix>-major`, where
`branch_prefix` defaults to `next`. Configured branch names must end in `-minor` or `-major`.

For a minor-only Effect V3 queue:

```yaml
- uses: Effect-TS/next-release-action@main
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    base_branch: v3
    eligible_branches: v3/next-minor
```

## Development

```sh
vp install
vp check
vp test
vp pack
```

## License

MIT

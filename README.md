# Lizard CLI

Deploy and manage apps on [Lizard](https://lizard.build).

## Install

```bash
curl -fsSL https://lizard.build/install.sh | bash
```

Or via npm:

```bash
npm i -g @lizard-build/cli
```

## Usage

```bash
lizard login
lizard init
lizard up
```

## Common commands

```
lizard up         # upload and deploy code
lizard logs       # stream runtime logs
lizard ps         # list services
lizard add        # add a database or service
lizard secrets    # manage secrets
lizard scale      # scale replicas / CPU / memory
lizard domain     # manage domains
```

Run `lizard --help` for the full list.

## License

MIT

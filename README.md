# nsite-gateway

A Typescript implementation of [static websites on nostr](https://github.com/nostr-protocol/nips/pull/1538)

## Running with docker-compose

```sh
git clone https://github.com/hzrd149/nsite-gateway.git
cd nsite-gateway
docker compose up
```

Once the service is running you can access the cached version at `http://localhost:8080`

If you need to test, you can directly access the ts server at `http://localhost:3000`

## Running with docker

The `ghcr.io/hzrd149/nsite-gateway` image can be used to run a http instance locally

```sh
docker run --rm -it --name nsite -p 8080:80 ghcr.io/hzrd149/nsite-gateway
```

## Manual nginx setup

Before manually setting up nginx and nsite-gateway you need a few things installed

- [nginx](https://nginx.org/)
- [nodejs](https://nodejs.org/en/download/package-manager) (dep packages [here](https://deb.nodesource.com/))
- [pnpm](https://pnpm.io/) run `npm i -g pnpm` to install

Next your going to need to clone the nsite-gateway repo and set it up

```sh
git clone https://github.com/hzrd149/nsite-gateway
cd nsite-gateway

# install dependencies
pnpm install

# build app
pnpm build
```

Then create a new `.env` file for configuration

```sh
cp .env.example .env
```

Next copy and setup the systemd service

```sh
sudo cp contrib/nsite.service /etx/systemd/system/nsite.service

# edit the service and set the working directory path
sudo nano /etx/systemd/system/nsite.service

# reload systemd service
sudo systemctl daemon-reload

# start service
sudo systemctl start nsite
```

Then once nsite-gateway is running, next you need to configure nginx

Start by modifying the `/etx/nginx/nginx.conf` file and adding a `proxy_cache_path` to the `http` section

```sh
sudo nano /etc/nginx/nginx.conf
```

```diff
http {
+  proxy_cache_path /var/cache/nginx levels=1:2 keys_zone=request_cache:10m max_size=10g inactive=60m use_temp_path=off;
}
```

Next modify the default site config (usually `/etx/nginx/sites-enabled/default` or `/etc/nginx/conf.d/default.conf`) to be one of

- [nginx/http.conf](./nginx/http.conf)
- [nginx/tls.conf](./nginx/tls.conf)
- [nginx/tls-and-tor.conf](./nginx/tls-and-tor.conf)

Once that is done you can restart nginx and you should have a new nsite server running on port 80

## Tor setup

First you need to install tor (`sudo apt install tor` on debian systems) or [Documentation](https://community.torproject.org/onion-services/setup/install/)

Then able the tor service

```sh
sudo systemctl enable tor
sudo systemctl start tor
```

### Setup hidden service

Modify the torrc file to enable `HiddenServiceDir` and `HiddenServicePort`

```
HiddenServiceDir /var/lib/tor/hidden_service/
HiddenServicePort 80 127.0.0.1:8080
```

Then restart tor

```sh
sudo systemctl restart tor
```

Next get the onion address using `cat /var/lib/tor/hidden_service/hostname` and set the `ONION_HOST` variable in the `.env` file

```sh
# don't forget to start with http://
ONION_HOST="http://q457mvdt5smqj726m4lsqxxdyx7r3v7gufzt46zbkop6mkghpnr7z3qd.onion"
```

### Connecting to Tor and I2P relays and blossom servers

Install Tor ([Documentation](https://community.torproject.org/onion-services/setup/install/)) and optionally I2Pd ([Documentation](https://i2pd.readthedocs.io/en/latest/user-guide/install/)) and then add the `TOR_PROXY` and `I2P_PROXY` variables to the `.env` file

```sh
TOR_PROXY=127.0.0.1:9050
I2P_PROXY=127.0.0.1:4447
```

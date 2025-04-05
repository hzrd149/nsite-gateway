# nsite-gateway

A Typescript implementation of [static websites on nostr](https://github.com/nostr-protocol/nips/pull/1538)

## Configuring

All configuration is done through the `.env` file. start by copying the example file and modifying it.

```sh
cp .env.example .env
```

## Running with npx

```sh
npx nsite-gateway
```

## Running with docker-compose

```sh
git clone https://github.com/hzrd149/nsite-gateway.git
cd nsite-gateway
docker compose up
```

Once the service is running you can access the gateway at `http://localhost:3000`

## Running with docker

The `ghcr.io/hzrd149/nsite-gateway` image can be used to run a http instance locally

```sh
docker run --rm -it --name nsite -p 3000:3000 ghcr.io/hzrd149/nsite-gateway
```

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

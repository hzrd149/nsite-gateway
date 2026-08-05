{
  config,
  lib,
  pkgs,
  ...
}:

{
  # This is a complete demonstration VM, not a production server baseline.
  services.nsite-gateway = {
    enable = true;
    openFirewall = true;

    settings = {
      NSITE_HOST = "0.0.0.0";
      NSITE_PORT = "3000";
      PUBLIC_DOMAIN = "localhost:3000";
      NOSTR_RELAYS = "wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net";
    };
  };

  environment.systemPackages = [ pkgs.curl ];

  # Console credentials for this disposable demonstration VM.
  # Do not copy this plaintext password into a production configuration.
  users.users.nsite = {
    isNormalUser = true;
    initialPassword = "nsite";
    extraGroups = [ "wheel" ];
  };
  security.sudo.wheelNeedsPassword = false;

  # `nix run .#vm` forwards the gateway to 127.0.0.1:3000 on the host.
  virtualisation = {
    graphics = false;
    memorySize = 2048;
    cores = 2;
    # Keep the demonstration disposable instead of creating a qcow2 image.
    diskImage = null;
    forwardPorts = [
      {
        from = "host";
        proto = "tcp";
        host.address = "127.0.0.1";
        host.port = lib.toInt config.services.nsite-gateway.settings.NSITE_PORT;
        guest.port = lib.toInt config.services.nsite-gateway.settings.NSITE_PORT;
      }
    ];
  };

  networking.hostName = "nsite-gateway-vm";
  system.stateVersion = "26.05";
}

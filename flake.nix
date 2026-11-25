{
  description = "X-WebView — runs Electron apps on the system WebKit";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachSystem [ "x86_64-linux" "aarch64-linux" ] (system:
      let
        pkgs = import nixpkgs { inherit system; };
        nodejs = pkgs.nodejs_24;

        x_webview = pkgs.buildNpmPackage {
          pname = "x-webview";
          version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
          src = self;

          # Read from package-lock.json, so there is no deps hash to keep in step with it.
          npmDeps = pkgs.importNpmLock { npmRoot = ./.; };
          npmConfigHook = pkgs.importNpmLock.npmConfigHook;
          inherit nodejs;

          nativeBuildInputs = with pkgs; [ makeWrapper wrapGAppsHook3 gobject-introspection ];

          # The window host's libraries, TLS for WebKit's network process, and the GStreamer plugins pages play media with.
          buildInputs = with pkgs; [
            gjs
            gtk3
            webkitgtk_4_1
            glib-networking
            gsettings-desktop-schemas
            gst_all_1.gstreamer
            gst_all_1.gst-plugins-base
            gst_all_1.gst-plugins-good
            gst_all_1.gst-libav
          ];

          buildPhase = ''
            runHook preBuild
            npm run build
            runHook postBuild
          '';

          # The wrapper stands where the electron binary would, so the app's daemon and relaunches run through it too.
          installPhase = ''
            runHook preInstall
            npm prune --omit=dev --ignore-scripts
            mkdir -p $out/lib/x-webview
            cp -r dist node_modules package.json $out/lib/x-webview/
            makeWrapper ${nodejs}/bin/node $out/bin/x-webview \
              --add-flags $out/lib/x-webview/dist/node/cli.js \
              --set X_WEBVIEW_GJS ${pkgs.gjs}/bin/gjs \
              --set X_WEBVIEW_LAUNCHER $out/bin/x-webview
            runHook postInstall
          '';

          # The GTK wrapping is added to the one wrapper rather than layered as a second script.
          dontWrapGApps = true;
          postFixup = ''
            wrapProgram $out/bin/x-webview "''${gappsWrapperArgs[@]}"
          '';

          meta = {
            description = "Runs Electron apps on the system WebKit";
            license = pkgs.lib.licenses.gpl3Plus;
            mainProgram = "x-webview";
            platforms = [ "x86_64-linux" "aarch64-linux" ];
          };
        };

        # An Electron app packaged to run on X-WebView: `app` is a folder holding the built app, such as an app package's lib/<name>.
        # The folder is copied rather than referenced, so the app package's own Electron is not carried along. `share` is a
        # package whose desktop files and icons are copied, `environment` adds variables and `path` adds tools to the PATH.
        wrap_app = { name, app, share ? null, environment ? { }, path ? [ ] }:
          let
            inherit (pkgs) lib;
            environment_flags = lib.concatStringsSep " " (lib.mapAttrsToList (key: value: "--set ${key} ${lib.escapeShellArg value}") environment);
            path_flags = lib.optionalString (path != [ ]) "--prefix PATH : ${lib.makeBinPath path}";
          in
          pkgs.runCommand name {
            nativeBuildInputs = [ pkgs.makeWrapper ];
            meta.mainProgram = name;
          } ''
            mkdir -p $out/bin $out/lib $out/share/x-webview
            cp -r --no-preserve=mode ${app} $out/lib/${name}
            ${x_webview}/bin/x-webview --bundle-into $out/share/x-webview/preloads $out/lib/${name}
            makeWrapper ${x_webview}/bin/x-webview $out/bin/${name} \
              --set X_WEBVIEW_PACKAGED_APP $out/lib/${name} \
              --set X_WEBVIEW_LAUNCHER $out/bin/${name} \
              --set X_WEBVIEW_PRELOADS $out/share/x-webview/preloads \
              ${environment_flags} ${path_flags}
            ${lib.optionalString (share != null) ''
              for folder in applications icons; do
                if [ -d ${share}/share/$folder ]; then cp -r --no-preserve=mode ${share}/share/$folder $out/share/; fi
              done
            ''}
          '';
      in
      {
        packages.default = x_webview;

        lib = { inherit wrap_app; };

        devShells.default = pkgs.mkShell {
          packages = [ nodejs pkgs.gjs ];
          inputsFrom = [ x_webview ];
        };
      });
}

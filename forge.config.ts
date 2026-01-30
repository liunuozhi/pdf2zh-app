import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Copy native/external Node modules and their transitive dependencies into the
 * packaged app so they can be resolved at runtime.
 * Vite marks these as external, so they aren't in the bundle.
 */
const EXTERNAL_MODULES = ['canvas', 'onnxruntime-node', 'sharp', 'pdfjs-dist', 'path2d'];

function collectDeps(moduleName: string, srcNodeModules: string, collected: Set<string>) {
  if (collected.has(moduleName)) return;
  const modDir = path.join(srcNodeModules, moduleName);
  if (!fs.existsSync(modDir)) return;
  collected.add(moduleName);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(modDir, 'package.json'), 'utf-8'));
    for (const dep of Object.keys(pkg.dependencies || {})) {
      collectDeps(dep, srcNodeModules, collected);
    }
    for (const dep of Object.keys(pkg.optionalDependencies || {})) {
      collectDeps(dep, srcNodeModules, collected);
    }
  } catch { /* ignore */ }
}

function copyNativeModules(buildPath: string, _electronVersion: string, _platform: string, _arch: string, callback: (err?: Error | null) => void) {
  const srcNodeModules = path.resolve(__dirname, 'node_modules');
  const destNodeModules = path.join(buildPath, 'node_modules');
  fs.mkdirSync(destNodeModules, { recursive: true });

  const allDeps = new Set<string>();
  for (const mod of EXTERNAL_MODULES) {
    collectDeps(mod, srcNodeModules, allDeps);
  }

  for (const mod of allDeps) {
    const src = path.join(srcNodeModules, mod);
    const dest = path.join(destNodeModules, mod);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      fs.cpSync(src, dest, { recursive: true });
    }
  }

  callback();
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: false,
    icon: 'assets/icon',
    extraResource: ['assets'],
    afterCopy: [copyNativeModules],
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
    new MakerDeb({}),
  ],
  plugins: [
    // AutoUnpackNativesPlugin removed — asar is disabled for native module compatibility
    new VitePlugin({
      build: [
        {
          entry: 'src/main/index.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: false,
    }),
  ],
};

export default config;

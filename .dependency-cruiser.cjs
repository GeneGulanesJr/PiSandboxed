/** Enforces: server -> core -> ports <- adapters. See spec §3 Modularity rules. */
module.exports = {
  forbidden: [
    {
      name: 'core-cannot-import-adapters',
      comment: 'core depends ONLY on ports and its own module',
      from: { path: '^src/core/' },
      to: { path: '^src/(adapters|modes|promote|server|cli)/' },
    },
    {
      name: 'adapters-cannot-import-server',
      from: { path: '^src/(adapters|modes|promote)/' },
      to: { path: '^src/server/' },
    },
    {
      name: 'cli-is-a-pure-http-client',
      from: { path: '^src/cli/' },
      to: { path: '^src/(core|adapters|modes|promote|server)/' },
    },
    {
      name: 'only-composition-root-wires-everything',
      comment: 'only main.ts may import core AND adapters together',
      from: { path: '^src/server/', pathNot: '^src/server/main\\.ts$' },
      to: { path: '^src/(adapters|modes|promote)/' },
    },
  ],
};

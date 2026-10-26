import { parseArgs } from "node:util";

export const help = `Usage: ./dev <command> [options]

  doctor [--json] [--offline]       Inspect this checkout without installing anything
  setup [--offline] [--install-hooks]
                                   Install pinned local tools and a synthetic map
  demo [--port <port>]             Serve the synthetic map on loopback
  check [--profile fast|full]       Run focused checks (default: fast) or the CI suite
  test [-- <Playwright arguments>] Build WASM, prepare fixtures and run browser tests
  fixtures                        Prepare all synthetic browser-test datasets
  package --target <triple>        Build a Linux release with the optional release tools

Use ./dev <command> --help for this summary. Full checks include the reviewed
public demo download; ordinary setup and browser tests need no Minecraft assets.
Supported package targets: x86_64-unknown-linux-musl, aarch64-unknown-linux-musl.
`;

export function invocation(argv) {
  if (argv.length === 0) return { command: "doctor", values: {}, tail: [] };
  if (["help", "--help", "-h"].includes(argv[0])) {
    if (argv.length !== 1)
      throw Error("Help does not accept additional arguments");
    return { command: "help", values: {}, tail: [] };
  }
  const [command, ...args] = argv;
  const options = {
    doctor: { json: { type: "boolean" }, offline: { type: "boolean" } },
    setup: {
      offline: { type: "boolean" },
      "install-hooks": { type: "boolean" },
    },
    demo: { port: { type: "string" } },
    fixtures: {},
    check: { profile: { type: "string", default: "fast" } },
    test: {},
    package: { target: { type: "string" } },
  }[command];
  if (!options)
    throw Error(`Unknown dev command: ${command}. Run ./dev --help.`);
  const separator = args.indexOf("--");
  const tail = separator < 0 ? [] : args.slice(separator + 1);
  if (separator >= 0 && command !== "test")
    throw Error("Only test accepts arguments after --");
  const { values } = parseArgs({
    args: separator < 0 ? args : args.slice(0, separator),
    options: { ...options, help: { type: "boolean", short: "h" } },
    allowPositionals: false,
    strict: true,
  });
  if (values.help) return { command: "help", values: {}, tail: [] };
  if (
    values.port !== undefined &&
    (!/^\d+$/.test(values.port) ||
      Number(values.port) < 1024 ||
      Number(values.port) > 65535)
  )
    throw Error("demo --port must be an integer from 1024 to 65535");
  if (command === "check" && !["fast", "full"].includes(values.profile))
    throw Error(`Unknown check profile: ${values.profile}`);
  if (
    command === "package" &&
    !["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"].includes(
      values.target,
    )
  )
    throw Error(
      "package requires --target x86_64-unknown-linux-musl or aarch64-unknown-linux-musl",
    );
  return { command, values, tail };
}

export const fixtureSteps = [
  [
    "cargo",
    "run",
    "--locked",
    "-p",
    "surface-cli",
    "--",
    "fixture",
    "--output",
    "web/public/maps/fixture",
  ],
  [
    "cargo",
    "run",
    "--locked",
    "-p",
    "surface-cli",
    "--",
    "fixture",
    "--coast",
    "--output",
    "web/public/maps/coast",
  ],
  ["node", "scripts/terrain-fixture.mjs"],
];

export function checkSteps(profile) {
  const common = [
    ["cargo", "fmt", "--all", "--check"],
    ["npm", "run", "format:check"],
    ...[
      "config:test",
      "release:test",
      "tracking:test",
      "terrain:test",
      "demo:test",
    ].map((name) => ["npm", "run", name]),
  ];
  if (profile === "fast")
    return [
      ...common,
      ["npm", "run", "check"],
      ["cargo", "test", "-p", "surface-core", "--locked"],
    ];
  if (profile !== "full") throw Error(`Unknown check profile: ${profile}`);
  return [
    ...common,
    ["npm", "run", "secrets:check"],
    [
      "cargo",
      "clippy",
      "--workspace",
      "--all-targets",
      "--locked",
      "--",
      "-D",
      "warnings",
    ],
    [
      "cargo",
      "clippy",
      "-p",
      "surface-gpu",
      "--target",
      "wasm32-unknown-unknown",
      "--locked",
      "--",
      "-D",
      "warnings",
    ],
    ["cargo", "test", "--workspace", "--locked"],
    ["npm", "run", "build"],
    ["npm", "run", "tracking:build"],
    ["npm", "run", "terrain:build"],
    ...fixtureSteps,
    ["npx", "--no-install", "playwright", "test"],
    ["npm", "run", "demo:build"],
    ["node", "scripts/check-demo.mjs"],
    ["node", "scripts/audit-demo.mjs"],
  ];
}

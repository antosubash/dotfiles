import type { QaAuth } from "./qa-manifest.js";
import { object, onlyKeys, parseArgv, parseEnv, parseNotes, SAFE_NAME, safeRepositoryPath } from "./qa-manifest-fields.js";

export function parseAuth(raw: unknown): QaAuth {
  const auth = object(raw, "QA manifest auth");
  onlyKeys(auth, ["storageState", "setup", "roles", "notes"], "QA manifest auth");
  if (typeof auth.storageState !== "string") throw new Error("QA manifest auth.storageState must be a string");
  const notes = parseNotes(auth.notes, "QA manifest auth");
  const parsed: QaAuth = {
    storageState: safeRepositoryPath(auth.storageState, "QA manifest auth.storageState"),
    ...(notes === undefined ? {} : { notes }),
  };
  if (auth.setup !== undefined) {
    const setup = object(auth.setup, "QA manifest auth.setup");
    onlyKeys(setup, ["argv", "env", "envFromEndpoints"], "QA manifest auth.setup");
    parsed.setup = {
      argv: parseArgv(setup.argv, "QA manifest auth.setup"),
      ...(setup.env === undefined ? {} : { env: parseEnv(setup.env, "QA manifest auth.setup env") }),
      ...(setup.envFromEndpoints === undefined ? {} : {
        envFromEndpoints: parseEnv(setup.envFromEndpoints, "QA manifest auth.setup envFromEndpoints", SAFE_NAME),
      }),
    };
  }
  if (auth.roles !== undefined) {
    if (!parsed.setup) throw new Error("QA manifest auth.roles requires auth.setup");
    const roles = object(auth.roles, "QA manifest auth.roles");
    const entries = Object.entries(roles);
    if (entries.length > 8) throw new Error("QA manifest auth.roles allows at most 8 roles");
    parsed.roles = {};
    const states = new Set([parsed.storageState]);
    for (const [name, value] of entries) {
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(name)) throw new Error(`QA manifest auth.roles name is invalid: ${name}`);
      const role = object(value, `QA manifest auth.roles.${name}`);
      onlyKeys(role, ["env", "storageState"], `QA manifest auth.roles.${name}`);
      if (typeof role.storageState !== "string") throw new Error(`QA manifest auth.roles.${name}.storageState must be a string`);
      const storageState = safeRepositoryPath(role.storageState, `QA manifest auth.roles.${name}.storageState`);
      if (states.has(storageState)) throw new Error(`QA manifest auth.roles.${name}.storageState must differ from every other role's`);
      states.add(storageState);
      parsed.roles[name] = {
        storageState,
        ...(role.env === undefined ? {} : { env: parseEnv(role.env, `QA manifest auth.roles.${name} env`) }),
      };
    }
  }
  return parsed;
}

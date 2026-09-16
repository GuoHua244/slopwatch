/** Thrown when a unique user name collides (HTTP 409). */
export class UserExistsError extends Error {
  constructor(name: string) {
    super(`user "${name}" already exists`);
    this.name = "UserExistsError";
  }
}

/** Thrown when a unique team name collides (HTTP 409). */
export class TeamExistsError extends Error {
  constructor(name: string) {
    super(`team "${name}" already exists`);
    this.name = "TeamExistsError";
  }
}

/** Thrown when a team id does not exist (HTTP 404). */
export class NoSuchTeamError extends Error {
  constructor() {
    super("no such team");
    this.name = "NoSuchTeamError";
  }
}

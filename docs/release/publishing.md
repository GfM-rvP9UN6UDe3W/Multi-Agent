# Publishing: owner steps

This file is the only source for the steps the owner performs by hand to publish the project ([SPEC-0021](../specs/0021-open-source-readiness.md) P06). Each step says how long it takes, what success looks like and what to do if it fails. Steps are added as the work reaches them.

## 1. Register the npm organization `orchvia`

About 5 minutes. Needs the network. Changes nothing that exists today. Do it before the repository is renamed, because renaming makes the name public and scopes are first come, first served.

1. Open https://www.npmjs.com/org/create and sign in to your npm account. If you have none, create one and turn on two-factor authentication first.
   - Success: the "Create an Organization" form appears.
2. Enter `orchvia` as the organization name and choose the free plan for unlimited public packages.
   - Success: the page confirms the organization, and https://www.npmjs.com/org/orchvia opens.
   - Failure: if the name is taken, stop and report it. Do not pick another name on your own.
3. Skip inviting members.
4. Optional: on GitHub, create the organization `orchvia` as well (https://github.com/organizations/plan, free plan), so nobody else can take it. The repository does not move there.
   - Success: https://github.com/orchvia opens as your organization.
5. Report back: "npm organization orchvia is created" (and whether step 4 was done).

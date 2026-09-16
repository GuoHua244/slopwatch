/** Shown when a signed-in user opens a route their role may not see. */
export const NotAuthorized = ({ route }: { route: string }) => (
  <main className="full">
    <section>
      <div className="stage narrow">
        <h2 className="page-title">Not authorized</h2>
        <p className="page-sub">
          The {route} area is for admins. Your account has the member role — ask
          an admin to promote you if you need access.
        </p>
        <p>
          <a href="#/sessions">Back to sessions</a>
        </p>
      </div>
    </section>
  </main>
);

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user) {
      return res.redirect(role === "admin" ? "/login/admin" : "/login/teacher");
    }
    if (req.session.user.role !== role) {
      return res.status(403).send("Forbidden");
    }
    return next();
  };
}

function requireAnyAuth(req, res, next) {
  if (!req.session.user) return res.redirect("/");
  return next();
}

module.exports = {
  requireRole,
  requireAnyAuth
};

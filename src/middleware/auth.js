function requireRole(roleOrRoles) {
  const allowedRoles = Array.isArray(roleOrRoles) ? roleOrRoles : [roleOrRoles];

  return (req, res, next) => {
    if (!req.session.user) {
      return res.redirect(allowedRoles.includes("admin") ? "/login/admin" : "/login/teacher");
    }
    if (!allowedRoles.includes(req.session.user.role)) {
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

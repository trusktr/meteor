// XXX TODO: Separate the interning functionality
// from the "represent the catalog's dependencies" functionality.
// Make it serializable.

// XXX Requires:
// - every unit version ever used was added with addUnitVersion
// - every constraint ever used was instantiated with getConstraint
// - every constraint was added exactly once
// - every unit version was added exactly once

DependencyCache = function () {
  var self = this;

  // Maps unit name string to a sorted array of version definitions
  self.unitsVersions = {};
  // Maps name@version string to a unit version
  self._unitsVersionsMap = {};

  // Refs to all constraints. Mapping String -> instance
  self._constraints = {};
};
ConstraintSolver.DependencyCache = DependencyCache;

DependencyCache.prototype.addUnitVersion = function (unitVersion) {
  var self = this;

  check(unitVersion, ConstraintSolver.UnitVersion);

  if (_.has(self._unitsVersionsMap, unitVersion.toString())) {
    throw Error("duplicate uv " + unitVersion.toString() + "?");
  }

  if (! _.has(self.unitsVersions, unitVersion.name)) {
    self.unitsVersions[unitVersion.name] = [];
  } else {
    var latest = _.last(self.unitsVersions[unitVersion.name]).version;
    if (!PackageVersion.lessThan(latest, unitVersion.version)) {
      throw Error("adding uv out of order: " + latest + " vs "
                  + unitVersion.version);
    }
  }

  self.unitsVersions[unitVersion.name].push(unitVersion);
  self._unitsVersionsMap[unitVersion.toString()] = unitVersion;
};


// XXX this function is never actually called
DependencyCache.prototype.getUnitVersion = function (unitName, version) {
  var self = this;
  return self._unitsVersionsMap[unitName + "@" + version];
};

// name - String - "someUnit"
// versionConstraint - String - "=1.2.3" or "2.1.0"
DependencyCache.prototype.getConstraint =
  function (name, versionConstraint) {
  var self = this;

  check(name, String);
  check(versionConstraint, String);

  var idString = JSON.stringify([name, versionConstraint]);

  if (_.has(self._constraints, idString))
    return self._constraints[idString];

  return self._constraints[idString] =
    new ConstraintSolver.Constraint(name, versionConstraint);
};



////////////////////////////////////////////////////////////////////////////////
// UnitVersion
////////////////////////////////////////////////////////////////////////////////

ConstraintSolver.UnitVersion = function (name, unitVersion) {
  var self = this;

  check(name, String);
  check(unitVersion, String);
  check(self, ConstraintSolver.UnitVersion);

  self.name = name;
  // Things with different build IDs should represent the same code, so ignore
  // them. (Notably: depending on @=1.3.1 should allow 1.3.1+local!)
  self.version = PackageVersion.removeBuildID(unitVersion);
  self.dependencies = [];
  self.constraints = new ConstraintSolver.ConstraintsList();
  // integer like 1 or 2
  self.majorVersion = PackageVersion.majorVersion(unitVersion);
};

_.extend(ConstraintSolver.UnitVersion.prototype, {
  addDependency: function (name) {
    var self = this;

    check(name, String);
    if (_.contains(self.dependencies, name)) {
      return;
    }
    self.dependencies.push(name);
  },
  addConstraint: function (constraint) {
    var self = this;

    check(constraint, ConstraintSolver.Constraint);
    if (self.constraints.contains(constraint)) {
      return;
      // XXX may also throw if it is unexpected
      throw new Error("Constraint already exists -- " + constraint.toString());
    }

    self.constraints = self.constraints.push(constraint);
  },

  toString: function (options) {
    var self = this;
    options = options || {};
    var name = options.removeUnibuild ? removeUnibuild(self.name) : self.name;
    return name + "@" + self.version;
  }
});

////////////////////////////////////////////////////////////////////////////////
// Constraint
////////////////////////////////////////////////////////////////////////////////

// Can be called either:
//    new PackageVersion.Constraint("packageA", "=2.1.0")
// or:
//    new PackageVersion.Constraint("pacakgeA@=2.1.0")
ConstraintSolver.Constraint = function (name, versionString) {
  var self = this;
  if (versionString) {
    name = name + "@" + versionString;
  }

  // See comment in UnitVersion constructor. We want to strip out build IDs
  // because the code they represent is considered equivalent.
  _.extend(self, PackageVersion.parseConstraint(name, {
    removeBuildIDs: true,
    archesOK: true
  }));
};

ConstraintSolver.Constraint.prototype.toString = function (options) {
  var self = this;
  options = options || {};
  var name = options.removeUnibuild ? removeUnibuild(self.name) : self.name;
  return name + "@" + self.constraintString;
};


ConstraintSolver.Constraint.prototype.isSatisfied = function (
  candidateUV, resolveContext) {

  var self = this;
  check(candidateUV, ConstraintSolver.UnitVersion);

  if (self.name !== candidateUV.name) {
    throw Error("asking constraint on " + self.name + " about " +
                candidateUV.name);
  }

  return _.some(self.constraints, function (currConstraint) {
     if (currConstraint.type === "any-reasonable") {
      // Non-prerelease versions are always reasonable, and if we are OK with
      // using RCs all the time, then they are reasonable too.
      if (!/-/.test(candidateUV.version) ||
          resolveContext.useRCsOK)
        return true;

      // Is it a pre-release version that was explicitly mentioned at the top
      // level?
      if (_.has(resolveContext.topLevelPrereleases, self.name) &&
          _.has(resolveContext.topLevelPrereleases[self.name],
                candidateUV.version)) {
        return true;
      }

      // Otherwise, not this pre-release!
      return false;
    }

    if (currConstraint.type === "exactly") {
      return currConstraint.version === candidateUV.version;
    }

    if (currConstraint.type !== "compatible-with") {
      throw Error("Unknown constraint type: " + currConstraint.type);
    }

    // If you're not asking for a pre-release (and you are not in pre-releases-OK
    // mode), you'll only get it if it was a top level explicit mention (eg, in
    // the release).
    if (!/-/.test(currConstraint.version) &&
        /-/.test(candidateUV.version) && !resolveContext.useRCsOK) {
      if (currConstraint.version === candidateUV.version)
        return true;
      if (!_.has(resolveContext.topLevelPrereleases, self.name) ||
          !_.has(resolveContext.topLevelPrereleases[self.name],
                 candidateUV.version)) {
        return false;
      }
    }

    // If the candidate version is less than the version named in the constraint,
    // we are not satisfied.
    if (PackageVersion.lessThan(candidateUV.version, currConstraint.version))
      return false;

    // To be compatible, the two versions must have the same major version
    // number.
    return candidateUV.majorVersion ===
      PackageVersion.majorVersion(currConstraint.version);
  });

};

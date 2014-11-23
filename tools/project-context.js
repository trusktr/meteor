var _ = require('underscore');
var path = require('path');

var buildmessage = require('./buildmessage.js');
var catalog = require('./catalog.js');
var catalogLocal = require('./catalog-local.js');
var catalogRemote = require('./catalog-remote.js');
var Console = require('./console.js').Console;
var files = require('./files.js');
var isopackets = require('./isopackets.js');
var packageMap = require('./package-map.js');
var utils = require('./utils.js');

exports.ProjectContext = function (appDir) {
  var self = this;

  self.rootDir = appDir;
  self.packageMap = null;

  // XXX #3006: Things we're leaving off for now:
  //  - constraints, combinedConstraints
  //  - cordovaPlugins, platforms
  //  - appId
  //  - muted (???)
  //  - includeDebug
};

_.extend(exports.ProjectContext.prototype, {
  resolveConstraints: function () {
    var self = this;
    buildmessage.assertInCapture();
    var cat = self._makeProjectCatalog();
    // Did we already report an error via buildmessage?
    if (! cat)
      return;

    var depsAndConstraints = self._getRootDepsAndConstraints(cat);
    var resolver = self._buildResolver(cat);

    var solution;
    buildmessage.enterJob("selecting package versions", function () {
      // XXX #3006 set previousSolution
      try {
        var d = +(new Date);
        solution = resolver.resolve(
          depsAndConstraints.deps, depsAndConstraints.constraints);
        console.log("TOOK", +(new Date) - d);
      } catch (e) {
        if (!e.constraintSolverError)
          throw e;
        buildmessage.error(e.message);
      }
    });

    if (!solution)
      return;  // error is already in buildmessage

    // XXX #3006 Check solution.usedRCs and maybe print something about it

    self.packageMap = new packageMap.PackageMap(solution.answer, cat);
  },

  _localPackageSearchDirs: function () {
    var self = this;
    var searchDirs = [path.join(self.rootDir, 'packages')];

    if (process.env.PACKAGE_DIRS) {
      // User can provide additional package directories to search in
      // PACKAGE_DIRS (colon-separated).
      _.each(process.env.PACKAGE_DIRS.split(':'), function (p) {
        searchDirs.push(path.resolve(p));
      });
    }

    if (files.inCheckout()) {
      // Running from a checkout, so use the Meteor core packages from the
      // checkout.
      searchDirs.push(path.join(files.getCurrentToolsDir(), 'packages'));
    }
    return searchDirs;
  },

  // Returns a layered catalog with information about the packages that can be
  // used in this project. Processes the package.js file from all local packages
  // but does not compile the packages.
  //
  // Must be run in a buildmessage context. On build error, returns null.
  _makeProjectCatalog: function () {
    var self = this;
    buildmessage.assertInCapture();

    var cat = new catalog.LayeredCatalog;
    cat.setCatalogs(new catalogLocal.LocalCatalog({ containingCatalog: cat }),
                    catalog.official);

    var searchDirs = self._localPackageSearchDirs();
    buildmessage.enterJob({ title: "scanning local packages" }, function () {
      cat.initialize({ localPackageSearchDirs: searchDirs });
      if (buildmessage.jobHasMessages())
        cat = null;
    });
    return cat;
  },

  _getRootDepsAndConstraints: function (cat) {
    var self = this;
    buildmessage.assertInCapture();

    var depsAndConstraints = {deps: [], constraints: []};

    self._addAppConstraints(depsAndConstraints);
    self._addLocalPackageConstraints(depsAndConstraints, cat.localCatalog);
    // XXX #3006 Add constraints from the release
    // XXX #3006 Add constraints from other programs
    // XXX #3006 Add a dependency on ctl
    return depsAndConstraints;
  },

  _addAppConstraints: function (depsAndConstraints) {
    var self = this;
    buildmessage.assertInCapture();

    buildmessage.enterJob({ title: "reading packages file" }, function () {
      var packagesFileLines = files.getLinesOrEmpty(self._getConstraintFile());
      _.each(packagesFileLines, function (line) {
        line = files.trimLine(line);
        if (line === '')
          return;
        try {
          var constraint = utils.parseConstraint(line);
        } catch (e) {
          if (!e.versionParserError)
          throw e;
          buildmessage.exception(e);
        }
        if (!constraint)
          return;  // recover by ignoring

        // Add a dependency ("this package must be used") and a constraint
        // ("... at this version (maybe 'any reasonable')").
        depsAndConstraints.deps.push(constraint.name);
        depsAndConstraints.constraints.push(constraint);
      });
    });
  },

  _addLocalPackageConstraints: function (depsAndConstraints, localCat) {
    var self = this;
    _.each(localCat.getAllPackageNames(), function (packageName) {
      var versionRecord = localCat.getLatestVersion(packageName);
      var constraint =
            utils.parseConstraint(packageName + "@=" + versionRecord.version);
      // Add a constraint ("this is the only version available") but no
      // dependency (we don't automatically use all local packages!)
      depsAndConstraints.constraints.push(constraint);
    });
  },

  _buildResolver: function (cat) {
    var self = this;

    var constraintSolverPackage =
          isopackets.load('constraint-solver')['constraint-solver'];
    var resolver =
      new constraintSolverPackage.ConstraintSolver.PackagesResolver(cat, {
        nudge: function () {
          Console.nudge(true);
        }
      });
    return resolver;
  },


  // Returns the file path to the .meteor/packages file, containing the
  // constraints for this specific project.
  _getConstraintFile : function () {
    var self = this;
    return path.join(self.rootDir, '.meteor', 'packages');
  }
});

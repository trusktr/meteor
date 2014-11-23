var _ = require('underscore');
var path = require('path');

var archinfo = require('./archinfo.js');
var buildmessage = require('./buildmessage.js');
var catalog = require('./catalog.js');
var catalogLocal = require('./catalog-local.js');
var catalogRemote = require('./catalog-remote.js');
var Console = require('./console.js').Console;
var files = require('./files.js');
var isopackCache = require('./isopack-cache.js');
var isopackets = require('./isopackets.js');
var packageMap = require('./package-map.js');
var utils = require('./utils.js');
var watch = require('./watch.js');

// This class follows the standard protocol where names beginning with _ should
// not be externally accessed.
exports.ProjectContext = function (options) {
  var self = this;
  if (!options.projectDir)
    throw Error("missing projectDir!");
  if (!options.tropohouse)
    throw Error("missing tropohouse!");

  self.projectDir = options.projectDir;
  self.tropohouse = options.tropohouse;

  self._serverArchitectures = options.serverArchitectures || [];
  // We always need to download host versions of packages, at least for plugins.
  self._serverArchitectures.push(archinfo.host());
  self._serverArchitectures = _.uniq(self._serverArchitectures);

  // A WatchSet for all the files read by this class (eg .meteor/packages, etc).
  self.projectWatchSet = new watch.WatchSet;

  self.projectConstraintsFile = null;
  self.packageMap = null;
  self.isopackCache = null;

  // XXX #3006: Things we're leaving off for now:
  //  - combinedConstraints
  //  - cordovaPlugins, platforms
  //  - appId
  //  - muted (???)
  //  - includeDebug
};

_.extend(exports.ProjectContext.prototype, {
  prepareProjectForBuild: function () {
    var self = this;
    buildmessage.assertInCapture();

    buildmessage.enterJob('preparing project', function () {
      self.projectConstraintsFile = new exports.ProjectConstraintsFile(
        path.join(self.projectDir, '.meteor', 'packages'), {
          watchSet: self.projectWatchSet
        });
      if (buildmessage.jobHasMessages())
        return;

      self._resolveConstraints();
      if (buildmessage.jobHasMessages())
        return;

      self._downloadMissingPackages();
      if (buildmessage.jobHasMessages())
        return;

      self._buildLocalPackages();
      if (buildmessage.jobHasMessages())
        return;
    });
  },

  _resolveConstraints: function () {
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
        solution = resolver.resolve(
          depsAndConstraints.deps, depsAndConstraints.constraints);
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
    var searchDirs = [path.join(self.projectDir, 'packages')];

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

    var depsAndConstraints = {deps: [], constraints: []};

    self._addAppConstraints(depsAndConstraints);
    self._addLocalPackageConstraints(depsAndConstraints, cat.localCatalog);
    // XXX #3006 Add constraints from the release
    // XXX #3006 Add constraints from other programs, if we reimplement that.
    // XXX #3006 Add a dependency on ctl
    return depsAndConstraints;
  },

  _addAppConstraints: function (depsAndConstraints) {
    var self = this;

    self.projectConstraintsFile.eachConstraint(function (constraint) {
      // Add a dependency ("this package must be used") and a constraint
      // ("... at this version (maybe 'any reasonable')").
      depsAndConstraints.deps.push(constraint.name);
      depsAndConstraints.constraints.push(constraint);
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

  _downloadMissingPackages: function () {
    var self = this;
    buildmessage.assertInCapture();
    if (!self.packageMap)
      throw Error("which packages to download?");
    // XXX #3006 This downloads archinfo.host packages. How about
    //     for deploy?
    self.tropohouse.downloadPackagesMissingFromMap(self.packageMap, {
      serverArchitectures: self._serverArchitectures
    });
  },

  _buildLocalPackages: function () {
    var self = this;
    buildmessage.assertInCapture();

    self.isopackCache = new isopackCache.IsopackCache({
      cacheDir: path.join(self.projectDir, '.meteor', 'local', 'isopacks'),
      tropohouse: self.tropohouse
    });

    buildmessage.enterJob('building local packages', function () {
      self.isopackCache.buildLocalPackages(self.packageMap);
    });
  }
});


exports.ProjectConstraintsFile = function (filename, options) {
  var self = this;
  options = options || {};
  buildmessage.assertInCapture();

  self.filename = filename;
  // XXX #3006 Use a better data structure so that we can rewrite the file
  // later. But for now this maps from package name to parsed constraint.
  self._constraints = {};

  self._readFile(options.watchSet);
};

_.extend(exports.ProjectConstraintsFile.prototype, {
  _readFile: function (watchSet) {
    var self = this;
    buildmessage.assertInCapture();

    var contents = watch.readAndWatchFile(watchSet, self.filename);
    // No .meteor/packages? That's OK, you just get no packages.
    if (contents === null)
      return;
    var lines = files.splitBufferToLines(contents);
    _.each(lines, function (line) {
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
      if (_.has(self._constraints, constraint.name)) {
        buildmessage.error("Package name appears twice: " + constraint.name, {
          // XXX should this be relative?
          file: self.filename
        });
        return;  // recover by ignoring
      }
      self._constraints[constraint.name] = constraint;
    });
  },

  // Iterates over all constraints, in the format returned by
  // utils.parseConstraint.
  eachConstraint: function (iterator) {
    var self = this;
    _.each(self._constraints, function (constraint) {
      iterator(constraint);
    });
  }
});

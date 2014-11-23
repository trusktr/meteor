var _ = require('underscore');
var path = require('path');

var buildmessage = require('./buildmessage.js');
var compiler = require('./compiler.js');
var files = require('./files.js');
var isopackModule = require('./isopack.js');
var utils = require('./utils.js');
var watch = require('./watch.js');

exports.IsopackCache = function (options) {
  var self = this;
  options = options || {};
  // cacheDir may be null; in this case, we just don't ever save things to disk.
  self.cacheDir = options.cacheDir;
  // tropohouse may be null; in this case, we can't load versioned packages.
  // eg, for building isopackets.
  self.tropohouse = options.tropohouse;
  self.isopacks = {};
  self.allLoadedLocalPackagesWatchSet = new watch.WatchSet;

  if (self.cacheDir)
    files.mkdir_p(self.cacheDir);
};

_.extend(exports.IsopackCache.prototype, {
  buildLocalPackages: function (packageMap, rootPackageNames) {
    var self = this;
    buildmessage.assertInCapture();

    var onStack = {};
    if (rootPackageNames) {
      _.each(rootPackageNames, function (name) {
        self._ensurePackageLoaded(name, packageMap, onStack);
      });
    } else {
      packageMap.eachPackage(function (name, packageInfo) {
        self._ensurePackageLoaded(name, packageMap, onStack);
      });
    }
  },

  // Returns the isopack (already loaded in memory) for a given name. It is an
  // error to call this if it's not already loaded! So it should only be called
  // after buildLocalPackages has returned, or in the process of building a
  // package whose dependencies have all already been built.
  getIsopack: function (name) {
    var self = this;
    if (! _.has(self.isopacks, name))
      throw Error("isopack " + name + " not yet built?");
    return self.isopacks[name];
  },

  // XXX #3006 Don't infinite recurse on circular deps
  _ensurePackageLoaded: function (name, packageMap, onStack) {
    var self = this;
    buildmessage.assertInCapture();
    if (_.has(self.isopacks, name))
      return;

    var packageInfo = packageMap.getInfo(name);
    if (! packageInfo)
      throw Error("Depend on unknown package " + name + "?");

    if (packageInfo.kind === 'local') {
      var packageNames =
            packageInfo.packageSource.getPackagesToLoadFirst(packageMap);
      _.each(packageNames, function (depName) {
        if (_.has(onStack, depName)) {
          buildmessage.error("circular dependency between packages " +
                             name + " and " + depName);
          // recover by not enforcing one of the dependencies
          return;
        }
        onStack[depName] = true;
        self._ensurePackageLoaded(depName, packageMap, onStack);
        delete onStack[depName];
      });

      self._loadLocalPackage(name, packageInfo, packageMap);
    } else if (packageInfo.kind === 'versioned') {
      // We don't have to build this package, and we don't have to build its
      // dependencies either! Just load it from disk.

      if (!self.tropohouse) {
        throw Error("Can't load versioned packages without a tropohouse!");
      }

      // Load the isopack from disk.
      buildmessage.enterJob(
        "loading package " + name + "@" + packageInfo.version,
        function () {
          var isopackPath = self.tropohouse.packagePath(
            name, packageInfo.version);
          var isopack = new isopackModule.Isopack();
          isopack.initFromPath(name, isopackPath);
          self.isopacks[name] = isopack;
        });
    } else {
      throw Error("unknown packageInfo kind?");
    }
  },

  _loadLocalPackage: function (name, packageInfo, packageMap) {
    var self = this;
    buildmessage.assertInCapture();
    buildmessage.enterJob("building package " + name, function () {
      // Do we have an up-to-date package on disk?
      var isopackBuildInfoJson = self.cacheDir && files.readJSONOrNull(
        self._isopackBuildInfoPath(name));
      var upToDate = self._checkUpToDate({
        isopackBuildInfoJson: isopackBuildInfoJson,
        packageMap: packageMap
      });

      var isopack;
      if (upToDate) {
        isopack = new isopackModule.Isopack;
        isopack.initFromPath(name, self._isopackDir(name), {
          isopackBuildInfoJson: isopackBuildInfoJson
        });
      } else {
        // Nope! Compile it again.
        var compilerResult = compiler.compile(packageInfo.packageSource, {
          packageMap: packageMap,
          isopackCache: self
        });
        // Accept the compiler's result, even if there were errors (since it at
        // least will have a useful WatchSet and will allow us to keep going and
        // compile other packages that depend on this one).
        isopack = compilerResult.isopack;
        if (self.cacheDir && ! buildmessage.jobHasMessages()) {
          // Save to disk, for next time!
          var pluginProviderPackageMap = packageMap.makeSubsetMap(
            compilerResult.pluginProviderPackageNames);
          isopack.saveToPath(self._isopackDir(name), {
            pluginProviderPackageMap: pluginProviderPackageMap,
            includeIsopackBuildInfo: true
          });
        }
      }

      self.allLoadedLocalPackagesWatchSet.merge(isopack.getMergedWatchSet());
      self.isopacks[name] = isopack;
    });
  },

  _checkUpToDate: function (options) {
    var self = this;
    // If there isn't an isopack-buildinfo.json file, then we definitely aren't
    // up to date!
    if (! options.isopackBuildInfoJson)
      return false;
    // If any of the direct dependencies changed their version or location, we
    // aren't up to date.
    if (!options.packageMap.isSupersetOfJSON(
      options.isopackBuildInfoJson.pluginProviderPackageMap)) {
      return false;
    }
    // Merge in the watchsets for all unibuilds and plugins in the package, then
    // check it once.
    var watchSet = watch.WatchSet.fromJSON(
      options.isopackBuildInfoJson.pluginDependencies);

    _.each(options.isopackBuildInfoJson.unibuildDependencies, function (deps) {
      watchSet.merge(watch.WatchSet.fromJSON(deps));
    });
    return watch.isUpToDate(watchSet);
  },

  _isopackDir: function (packageName) {
    var self = this;
    return path.join(self.cacheDir,
                     utils.escapePackageNameForPath(packageName));
  },

  _isopackBuildInfoPath: function (packageName) {
    var self = this;
    return path.join(self._isopackDir(packageName), 'isopack-buildinfo.json');
  }
});

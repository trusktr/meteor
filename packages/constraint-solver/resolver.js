mori = Npm.require('mori');

BREAK = {};  // used by our 'each' functions

////////////////////////////////////////////////////////////////////////////////
// Resolver
////////////////////////////////////////////////////////////////////////////////

// XXX Assumes:
// - if two unit versions are the same, their refs point at the same object
// - if two constraints are the same, their refs point at the same object

ConstraintSolver.Resolver = function (depCache, options) {
  var self = this;

  self._depCache = depCache;

  options = options || {};

  self._nudge = options.nudge;
};

// options: Object:
// - costFunction: function (state, options) - given a state evaluates its cost
// - estimateCostFunction: function (state) - given a state, evaluates the
// estimated cost of the best path from state to a final state
// - combineCostFunction: function (cost, cost) - given two costs (obtained by
// evaluating states with costFunction and estimateCostFunction)
ConstraintSolver.Resolver.prototype.resolve = function (
    dependencies, constraints, options) {
  var self = this;
  constraints = constraints || [];
  var choices = mori.hash_map();  // uv.name -> uv
  options = _.extend({
    costFunction: function (state) { return 0; },
    estimateCostFunction: function (state) {
      return 0;
    },
    combineCostFunction: function (cost, anotherCost) {
      return cost + anotherCost;
    }
  }, options);

  var resolveContext = new ResolveContext;

  // Mapping that assigns every package an integer priority. We compute this
  // dynamically and in the process of resolution we try to resolve packages
  // with higher priority first. This helps the resolver a lot because if some
  // package has a higher weight to the solution (like a direct dependency) or
  // is more likely to break our solution in the future than others, it would be
  // great to try out and evaluate all versions early in the decision tree.
  // XXX this could go on ResolveContext
  var resolutionPriority = {};

  var startState = new ResolverState(self._depCache, resolveContext);

  if (options.useRCs) {
    resolveContext.useRCsOK = true;
  }

  _.each(constraints, function (constraint) {
    startState = startState.addConstraint(constraint, mori.list());

    // Keep track of any top-level constraints that mention a pre-release.
    // These will be the only pre-release versions that count as "reasonable"
    // for "any-reasonable" (ie, unconstrained) constraints.
    //
    // Why only top-level mentions, and not mentions we find while walking the
    // graph? The constraint solver assumes that adding a constraint to the
    // resolver state can't make previously impossible choices now possible.  If
    // pre-releases mentioned anywhere worked, then applying the constraints
    // "any reasonable" followed by "1.2.3-rc1" would result in "1.2.3-rc1"
    // ruled first impossible and then possible again. That's no good, so we
    // have to fix the meaning based on something at the start.  (We could try
    // to apply our prerelease-avoidance tactics solely in the cost functions,
    // but then it becomes a much less strict rule.)
    if (constraint.version && /-/.test(constraint.version)) {
      if (!_.has(resolveContext.topLevelPrereleases, constraint.name)) {
        resolveContext.topLevelPrereleases[constraint.name] = {};
      }
      resolveContext.topLevelPrereleases[constraint.name][constraint.version]
        = true;
    }
  });

  _.each(dependencies, function (unitName) {
    startState = startState.addDependency(unitName, mori.list());
    // Direct dependencies start on higher priority
    resolutionPriority[unitName] = 100;
  });

  if (startState.success()) {
    return startState.choices;
  }

  if (startState.error) {
    throwConstraintSolverError(startState.error);
  }

  var pq = new PriorityQueue();
  var overallCostFunction = function (state) {
    return [
      options.combineCostFunction(
        options.costFunction(state),
        options.estimateCostFunction(state)),
      -mori.count(state.choices)
    ];
  };

  pq.push(startState, overallCostFunction(startState));

  var someError = null;
  var anySucceeded = false;
  while (! pq.empty()) {
    // Since we're in a CPU-bound loop, allow yielding or printing a message or
    // something.
    self._nudge && self._nudge();

    var currentState = pq.pop();

    if (currentState.success()) {
      return currentState.choices;
    }

    var neighborsObj = self._stateNeighbors(currentState, resolutionPriority);

    if (! neighborsObj.success) {
      someError = someError || neighborsObj.failureMsg;
      resolutionPriority[neighborsObj.conflictingUnit] =
        (resolutionPriority[neighborsObj.conflictingUnit] || 0) + 1;
    } else {
      _.each(neighborsObj.neighbors, function (state) {
        // We don't just return the first successful one we find, in case there
        // are multiple successful states (we want to sort by cost function in
        // that case).
        pq.push(state, overallCostFunction(state));
      });
    }
  }

  // XXX should be much much better
  if (someError) {
    throwConstraintSolverError(someError);
  }

  throw new Error("ran out of states without error?");
};

var throwConstraintSolverError = function (message) {
  var e = new Error(message);
  e.constraintSolverError = true;
  throw e;
};

// returns {
//   success: Boolean,
//   failureMsg: String,
//   neighbors: [state]
// }
ConstraintSolver.Resolver.prototype._stateNeighbors = function (
    state, resolutionPriority) {
  var self = this;

  var candidateName = null;
  var candidateVersions = null;
  var currentNaughtiness = -1;

  state.eachDependency(function (unitName, versions) {
    var r = resolutionPriority[unitName] || 0;
    if (r > currentNaughtiness) {
      currentNaughtiness = r;
      candidateName = unitName;
      candidateVersions = versions;
    }
  });

  if (mori.is_empty(candidateVersions))
    throw Error("empty candidate set? should have detected earlier");

  var pathway = state.somePathwayForUnitName(candidateName);

  var neighbors = [];
  var firstError = null;
  mori.each(candidateVersions, function (unitVersion) {
    var neighborState = state.addChoice(unitVersion, pathway);
    if (!neighborState.error) {
      neighbors.push(neighborState);
    } else if (!firstError) {
      firstError = neighborState.error;
    }
  });

  if (neighbors.length) {
    return { success: true, neighbors: neighbors };
  }
  return {
    success: false,
    failureMsg: firstError,
    conflictingUnit: candidateName
  };
};

// An object that records the general context of a resolve call. It can be
// different for different resolve calls on the same Resolver, but is the same
// for every ResolverState in a given call.
var ResolveContext = function () {
  var self = this;
  // unitName -> version string -> true
  self.topLevelPrereleases = {};
  self.useRCsOK = false;
};

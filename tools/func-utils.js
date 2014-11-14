var _ = require("underscore");
var fiberHelpers = require("./fiber-helpers.js");

function wrap(wrapper, wrapped) {
  // Allow the wrapper to be used as a constructor function, just in case
  // the wrapped function was meant to be used as a constructor.
  wrapper.prototype = wrapped.prototype;

  // https://medium.com/@cramforce/on-the-awesomeness-of-fn-displayname-9511933a714a
  var name = wrapped.displayName || wrapped.name;
  if (name) {
    wrapper.displayName = name;
  }

  return wrapper;
}

// Create an instance from a constructor without actually invoking the
// constructor itself until the first time its methods are called.
exports.constructLazyInstance = function(constructor/*, arg1, arg2, ... */) {
  var proto = constructor.prototype;
  var instance = Object.create(proto);
  var constructorArgs = Array.prototype.slice.call(arguments, 1);
  var initialized = false;

  _.each(proto, function(value, key) {
    if (! _.isFunction(value)) {
      // Let non-method properties be inherited without any wrapping.
      return;
    }

    // Override each method with a wrapper that lazily initializes the
    // instance and then removes itself from the instance object so that
    // subsequent calls to this method will fall through to the actual
    // prototype method.
    wrap(instance[key] = function wrapper() {
      if (instance[key] === wrapper) {
        // Future calls to this method will invoke value directly without
        // going through the wrapper.
        delete instance[key];
      }

      if (! initialized) {
        constructor.apply(instance, constructorArgs);
        initialized = true;
      }

      // Use instance[key] instead of value just in case proto[key] has
      // changed since we created the wrapper. Also note that instance is
      // probably === this, but not necessarily: we might be invoking the
      // method against another object using .call or .apply, or the
      // method might have been inherited by a subclass, or we might be
      // invoking the method as a constructor. None of these scenarios are
      // likely, but we still need to use this instead of instance here,
      // just in case they're different.
      return instance[key].apply(this, arguments);
    }, value);
  });

  return instance;
};

// Return a function that coalesceses calls to fn that occur within delay
// milliseconds of each other, and prevents overlapping invocations of fn
// by postponing the next invocation until after fn's fiber finishes.
exports.coalesce = function(delayMs, callback, context) {
  var pendingTimer = null;
  var inProgress = 0;

  delayMs = delayMs || 100;

  function coalescingWrapper() {
    var self = context || this;

    if (inProgress) {
      // Indicate that coalescingWrapper should be called again after the
      // callback is no longer in progress.
      ++inProgress;
      return;
    }

    if (pendingTimer !== null) {
      // Defer to the already-pending timer.
      return;
    }

    var fiberCallback = fiberHelpers.inBareFiber(function() {
      // Now that the timeout has fired, set inProgress to 1 so that
      // (until the callback is complete and we set inProgress to 0 again)
      // any calls to coalescingWrapper will increment inProgress to
      // indicate that at least one other caller wants fiberCallback to be
      // called again when the original callback is complete.
      pendingTimer = null;
      inProgress = 1;

      try {
        callback.call(self);
      } finally {
        if (inProgress > 1)
          pendingTimer = setTimeout(fiberCallback, 10);
        inProgress = 0;
      }
    });

    pendingTimer = setTimeout(fiberCallback, delayMs);
  }

  return wrap(coalescingWrapper, callback);
};

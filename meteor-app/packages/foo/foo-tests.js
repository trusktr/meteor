// Import Tinytest from the tinytest Meteor package.
import { Tinytest } from "meteor/tinytest";

// Import and rename a variable exported by foo.js.
import { name as packageName } from "meteor/foo";

// Write your tests here!
// Here is an example.
Tinytest.add('foo - example', function (test) {
  test.equal(packageName, "foo");
});

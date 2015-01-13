serenity controller helper
===

Common module for serenity applications.

This module abstracts the common controller functionality
It provides CURD operations on top of sequelize model. Filtering and google partial response pattern is supported

## How to install?

Install via npm and git

```
npm install git+https://github.com/riteshsangwan/serenity-controller-helper.git
```

## Dependencies

- serenity-datasource (To access the datasource)
- serenity-route-helper (To process the response)
- serenity-param-helper (To parse request query filters)
- serenity-partial-response-helper (To support partial response)
- serenity-auth (For application authentication)


## Configuration

Application configuration is passed from application.
The configuration should define datasource configuration as specified by serenity-datasource package.
This module will instantiate an instance of datasource and will use it.

An optional 'query' config is provided which indicates default query size. If no query configuration is supplied default would be 50

Below is a sample configuration object

```
app: {
   query: 100
},
datasource: {
   pgURL: '<POSTGRESQL CONNECTION STRING>',
   modelsDirectory: '<MODELES DIRECTORY>'
}
```

The datasource configuration defined in above code sample is mandatory

## List of methods
Below is the list of method, for detailed method description see individual method docs

- buildController

This method returns a controller instance. Methods available on controller instance are defined below

- get
- create
- update
- all
- delete

## Example

```
var serenityControllerHelper = require('serenity-controller-helper');
var config = require('config');
// instantiate serenityControllerHelper
var controllerHelper = new serenityControllerHelper(config);

var challengeController = controllerHelper.buildController(Challenge, null, challengeControllerOptions);
// Now challengeController is an controller instance supporting CURD operatios on Challenge model
```

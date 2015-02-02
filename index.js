'use strict';

/**
 * Common module for serenity applications
 *
 * @author    spanhawk
 * @version   0.0.1
 *
 *
 * This module abstracts the common controller logic for serenity applications
 *
 * Dependencies
 * 1. serenity-datasource (To access the datasource)
 * 2. serenity-route-helper (To process the response)
 * 3. serenity-param-helper (To parse request query filters)
 * 4. serenity-partial-response-helper (To support partial response)
 * 5. serenity-auth (For application authentication)
 *
 * Application configuration is passed from application
 * The configuration should define datasource configuration as specified by serenity-datasource package
 * This module will instantiate an instance of datasource and will use it.
 *
 * An optional 'query' config is provided which indicates default query size. If no query configuration is supplied
 * default would be 50
 * Below is a sample configuration object
 *
 * app: {
 *   query: 100
 * },
 * datasource: {
 *   pgURL: '<POSTGRESQL CONNECTION STRING>',
 *   modelsDirectory: '<MODELES DIRECTORY>'
 * }
 */

/* Globals */
var async = require('async');
var _ = require('lodash');
var routeHelper = require('serenity-route-helper');
var paramHelper = require('serenity-param-helper');
var responseHelper = require('serenity-partial-response-helper');
var auth = require('serenity-auth');
var partialResponseHelper = null;
var serenityDatasource = require('serenity-datasource');
var queryConfig = null;
var errors = require('common-errors');


/**
 * Find an entity with the provided filters and its own id.
 * @param model the entity model
 * @param filters the current filters
 * @param req the request
 * @param callback the async callback
 */
function _findEntityByFilter(model, filters, req, callback) {
  // add the id parameter to the filters
  var idParam = routeHelper.getRefIdField(model);
  var idParamValue = req.swagger.params[idParam].value;
  var idValue = Number(idParamValue);
  // check id is valid numer and positive number
  if (_.isNaN(idValue) || idValue < 0) {
    callback(new errors.ValidationError('Invalid id parameter ' + idParamValue));
  } else {
    var refFilters = _.cloneDeep(filters);
    refFilters.where.id = idValue;
    model.find(refFilters).success(function(entity) {
      if (!entity) {
        callback(new errors.NotFoundError(model.name + ' with id ' + idParamValue));
      } else {
        callback(null, filters, entity);
      }
    })
    .error(function(err) {
      callback(new errors.Error('DBReadError: ' + err.message, err));
    });
  }
}

function _checkIdParamAndRequestBody(referenceModels, req, callback) {
  if(!referenceModels) {
    return callback();
  }
  referenceModels.forEach(function(refModel) {
    var idParam = routeHelper.getRefIdField(refModel);
    var idParamValue = req.swagger.params[idParam].value;
    var idValue = Number(idParamValue);
    if(req.body[idParam] && idValue!==Number(req.body[idParam])) {
      return callback(new errors.ValidationError(idParam + ' value should be same in path param as well as request body'));
    }
  });
  return callback();
}

/**
 * Build filters from request query parameters.
 * @param model the entity model
 * @param filtering the boolean flag of whether a filtering is enabled or not
 * @param filters the current filters
 * @param req the request
 * @param callback the async callback
 */
function _buildQueryFilter(model, filtering, filters, req, callback) {
  if (!filters) {
    filters = { where: {} };   // start with emtpty filter
  }

  var err;
  if (filtering) {
    filters.offset = 0;
    filters.limit = queryConfig.pageSize;
    // req.swagger.params returns empty value for non-existing parameters, it can't determine it's non-existing
    // or empty value. So req.query should be used to validate empty value and not-supportd parameters.
    // parse request parameters.
    try {
      _.each(_.keys(req.query), function(key) {
        if (key === 'offset' || key === 'limit') {
          paramHelper.parseLimitOffset(req, filters, key, req.query[key], callback);
        } else if (key === 'orderBy') {
          paramHelper.parseOrderBy(model, req, filters, req.query[key], callback);
        } else if (key === 'filter') {
          paramHelper.parseFilter(model, req, filters, req.query[key], callback);
        } else {
          throw new errors.ValidationError('The request parameter ' + key + ' is not supported');
        }
      });
    }  catch (validationError) {
      if (err) {
        err.addError(err);
      } else {
        err = validationError;
      }
    }
  }
  callback(err, filters);
}

/**
 * Build filters from reference models.
 * @param referenceModels the array of referencing models
 * @param req the request
 * @param callback the async callback
 */
function _buildReferenceFilter(referenceModels, req, callback) {
  var filters = { where: {} };   // start with emtpty filter
  if (!referenceModels) {
    callback(null, filters);
  } else {
    async.eachSeries(referenceModels, function (refModel, cb) {
      var idParam = routeHelper.getRefIdField(refModel);
      var idParamValue = req.swagger.params[idParam].value;
      var idValue = Number(idParamValue);
      // check id is valid numer and positive number
      if (_.isNaN(idValue) || idValue < 0) {
        cb(new errors.ValidationError('Invalid id parameter ' + idParamValue));
      } else {
        var refFilters = _.cloneDeep(filters);
        refFilters.where.id = idValue;
        // verify an element exists in the reference model
        refModel.find(refFilters).success(function (refEntity) {
          if(!refEntity) {
            cb(new errors.ValidationError('Cannot find the ' + refModel.name + ' with id '+ idParamValue));
          } else {
            // add the id of reference element to filters
            filters.where[idParam] = refEntity.id;
            cb(null);
          }
        }).error(function (err) {
            cb(new errors.Error('DBReadError: ' + err.message, err));
        });
      }
    }, function (err) {
      // pass err and filters to the next function in async
      callback(err, filters);
    });
  }
}

/**
 * Return error if there are extra parameters.
 * @param req the request
 * @param callback the async callback
 */
function _checkExtraParameters(req, callback) {
  if (_.keys(req.query).length > 0) {
    callback(new errors.ValidationError('Query parameter is not allowed'));
  } else {
    callback(null);
  }
}

/**
 * This function retrieves all entities in the model filtered by referencing model
    and search criterias if filtering is enabled.
 * @param model the entity model
 * @param referenceModels the array of referencing models
 * @param options the controller options
 * @param req the request
 * @param res the response
 * @param next the next function in the chain
 */
function getAllEntities(model, referenceModels, options, req, res, next) {
  async.waterfall([
    function(callback) {
      if (!options.filtering) {
        _checkExtraParameters(req, callback);
      } else {
        callback(null);
      }
    },
    function(callback) {
      _buildReferenceFilter(referenceModels, req, callback);
    },
    function(filters, callback) {
      _buildQueryFilter(model, options.filtering, filters, req, callback);
    },
    function(filters, callback) {
      // use entity filter IDs if configured
      if (options.entityFilterIDs) {
        filters.where = _.omit(filters.where, function(value, key) {
          return options.entityFilterIDs.indexOf(key) === -1;
        });
      }
      // add custom filters
      if(options.customFilters) {
        _.merge(filters, options.customFilters);
      }

      model.findAndCountAll(filters).success(function(result) {
        callback(null, result.count, result.rows);
      })
      .error(function(err) {
        callback(new errors.Error('DBReadError: ' + err.message, err));
      });
    }
  ], function(err, totalCount, entities) {
    if (err) {
      return next(err);  // go to error handler
    } else {
      req.data = {
        success: true,
        status: 200,
        metadata: {
          totalCount: totalCount
        },
        content: entities
      };
      partialResponseHelper.reduceFieldsAndExpandObject(model, req, next);
    }
  });

}

/**
 * This function gets an entity by id.
 * @param model the entity model
 * @param referenceModels the array of referencing models
 * @param options the controller options
 * @param res the response
 * @param next the next function in the chain
 */
function getEntity(model, referenceModels, options, req, res, next) {
  async.waterfall([
    function(callback) {
      _checkExtraParameters(req, callback);
    },
    function(callback) {
      _buildReferenceFilter(referenceModels, req, callback);
    },
    function(filters, callback) {
      // use entity filter IDs if configured
      if (options.entityFilterIDs) {
        filters.where = _.omit(filters.where, function(value, key) {
          return options.entityFilterIDs.indexOf(key) === -1;
        });
      }
      _findEntityByFilter(model, filters, req, callback);
    }
  ], function (err, entity) {
    if (err) {
      return next(err);  // go to error handler
    } else {
      req.data = {
        success: true,
        status: 200,
        content: entity
      };
      partialResponseHelper.reduceFieldsAndExpandObject(model, req, next);
    }
  });

}

/**
 * This function creates an entity.
 * @param model the entity model
 * @param referenceModels the array of referencing models
 * @param options the controller options
 * @param req the request
 * @param res the response
 * @param next the next function in the chain
 */
function createEntity(model, referenceModels, options, req, res, next) {
  async.waterfall([
    function(callback) {
      _checkIdParamAndRequestBody(referenceModels, req, callback);
    },
    function(callback) {
      _checkExtraParameters(req, callback);
    },
    function(callback) {
      _buildReferenceFilter(referenceModels, req, callback);
    },
    function(filters, callback) {
      // exclude prohibited fields
      var data = _.omit(req.swagger.params.body.value, 'id', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy');
      // set createdBy and updatedBy user
      data.createdBy = auth.getSigninUser(req).id;
      data.updatedBy = auth.getSigninUser(req).id;
      // add foreign keys
      _.extend(data, filters.where);
      model.create(data).success(function(entity) {
        callback(null, entity);
      })
      .error(function(err) {
        callback(new errors.Error('DBCreateError: ' + err.message, err));
      });
    }
  ], function (err, entity) {
    if (err) {
      return next(err);   // go to error handler
    } else {
      req.data = {
        id: entity.id,
        result: {
          success: true,
          status: 200
        }
      };
    }
    next();
  });
}

/**
 * This function updates an entity.
 * @param model the entity model
 * @param referenceModels the array of referencing models
 * @param options the controller options
 * @param req the request
 * @param res the response
 * @param next the next function in the chain
 */
function updateEntity(model, referenceModels, options, req, res, next) {
  async.waterfall([
    function(callback) {
      _checkIdParamAndRequestBody(referenceModels, req, callback);
    },
    function(callback) {
      _checkExtraParameters(req, callback);
    },
    function(callback) {
      _buildReferenceFilter(referenceModels, req, callback);
    },
    function(filters, callback) {
      // use entity filter IDs if configured
      if (options.entityFilterIDs) {
        filters.where = _.omit(filters.where, function(value, key) {
          return options.entityFilterIDs.indexOf(key) === -1;
        });
      }
      _findEntityByFilter(model, filters, req, callback);
    },
    function(filters, entity, callback) {
      var excludeFields = Object.keys(filters.where);
      _.map(['id', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'], function(field) {
        excludeFields.push(field);
      });
      // exclude prohibited fields
      var data = _.omit(req.swagger.params.body.value, excludeFields);
      _.extend(entity, data);
      entity.updatedBy = auth.getSigninUser(req).id;
      entity.save().success(function() {
        callback(null, entity);
        // req.data = {
        //   success: true,
        //   status: 200,
        //   content: entity
        // };
        // next();
      })
      .error(function(err) {
        callback(new errors.Error('DBSaveError: ' + err.message, err));
      });
    }
  ], function (err, entity) {
    if (err) {
      return next(err);   // go to error handler
    } else {
      req.data = {
        id: entity.id,
        result: {
          success: true,
          status: 200
        }
      };
    }
    next();
  });

}

/**
 * This function deletes an entity.
 * @param model the entity model
 * @param referenceModels the array of referencing models
 * @param options the controller options
 * @param req the request
 * @param res the response
 * @param next the next function in the chain
 */
function deleteEntity(model, referenceModels, options, req, res, next) {
  async.waterfall([
    function(callback) {
      _checkExtraParameters(req, callback);
    },
    function(callback) {
      _buildReferenceFilter(referenceModels, req, callback);
    },
    function(filters, callback) {
      // use entity filter IDs if configured
      if (options.entityFilterIDs) {
        filters.where = _.omit(filters.where, function(value, key) {
          return options.entityFilterIDs.indexOf(key) === -1;
        });
      }

      // add custom restriction to filters
      if(options.deletionRestrictions) {
        _.merge(filters, options.deletionRestrictions);
      }

      _findEntityByFilter(model, filters, req, callback);
    },
    function(filters, entity, callback) {
      entity.destroy().success(function() {
        callback(null, entity);
      })
      .error(function(err) {
        callback(new errors.Error('DBDeleteError: ' + err.message, err));
      });
    }
  ], function(err, entity) {
    if (err) {
      return next(err);   // go to error handler
    } else {
      req.data = {
        id: entity.id,
        result: {
          success: true,
          status: 200
        }
      };
    }
    next();
  });

}

function ControllerHelper(config) {
  queryConfig = config.app.query || 50;
  var datasource = new serenityDatasource(config);
  partialResponseHelper = new responseHelper(datasource);
}

/**
 * Build controller for model with the given options.
 * @param  {Model}    model               Sequelize Model
 * @param  {Array}    referenceModels     referenced models model is referencing
 * @param  {Object}   options             controller options
 * @return {Object}                       controller object
 */
ControllerHelper.prototype.buildController = function(model, referenceModels, options) {
  var controller = {};

  // Get an entity.
  controller.get = function(req, res, next) {
    getEntity(model, referenceModels, options, req, res, next);
  };

  // Create an entity.
  controller.create = function(req, res, next) {
    createEntity(model, referenceModels, options, req, res, next);
  };

  // Update an entity.
  controller.update = function(req, res, next) {
    updateEntity(model, referenceModels, options, req, res, next);
  };

  // Retrieve all entities.
  controller.all = function(req, res, next) {
    getAllEntities(model, referenceModels, options, req, res, next);
  };

  // Delete an entity.
  controller.delete = function(req, res, next) {
    deleteEntity(model, referenceModels, options, req, res, next);
  };

  return controller;
};

/**
 * Module exports
 */
module.exports = ControllerHelper;
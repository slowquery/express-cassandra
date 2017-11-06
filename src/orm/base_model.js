const Promise = require('bluebird');
const _ = require('lodash');
const util = require('util');

let dseDriver;
try {
  // eslint-disable-next-line import/no-extraneous-dependencies, import/no-unresolved
  dseDriver = require('dse-driver');
} catch (e) {
  dseDriver = null;
}

const cql = Promise.promisifyAll(dseDriver || require('cassandra-driver'));

const buildError = require('./apollo_error.js');
const schemer = require('../validators/schema');
const normalizer = require('../utils/normalizer');
const parser = require('../utils/parser');

const TableBuilder = require('../builders/table');
const ElassandraBuilder = require('../builders/elassandra');
const Driver = require('../helpers/driver');

const BaseModel = function f(instanceValues) {
  instanceValues = instanceValues || {};
  const fieldValues = {};
  const fields = this.constructor._properties.schema.fields;
  const methods = this.constructor._properties.schema.methods || {};
  const model = this;

  const defaultSetter = function f1(propName, newValue) {
    if (this[propName] !== newValue) {
      model._modified[propName] = true;
    }
    this[propName] = newValue;
  };

  const defaultGetter = function f1(propName) {
    return this[propName];
  };

  this._modified = {};
  this._validators = {};

  for (let fieldsKeys = Object.keys(fields), i = 0, len = fieldsKeys.length; i < len; i++) {
    const propertyName = fieldsKeys[i];
    const field = fields[fieldsKeys[i]];

    try {
      this._validators[propertyName] = schemer.get_validators(this.constructor._properties.schema, propertyName);
    } catch (e) {
      throw (buildError('model.validator.invalidschema', e.message));
    }

    let setter = defaultSetter.bind(fieldValues, propertyName);
    let getter = defaultGetter.bind(fieldValues, propertyName);

    if (field.virtual && typeof field.virtual.set === 'function') {
      setter = field.virtual.set.bind(fieldValues);
    }

    if (field.virtual && typeof field.virtual.get === 'function') {
      getter = field.virtual.get.bind(fieldValues);
    }

    const descriptor = {
      enumerable: true,
      set: setter,
      get: getter,
    };

    Object.defineProperty(this, propertyName, descriptor);
    if (!field.virtual) {
      this[propertyName] = instanceValues[propertyName];
    }
  }

  for (let methodNames = Object.keys(methods), i = 0, len = methodNames.length; i < len; i++) {
    const methodName = methodNames[i];
    const method = methods[methodName];
    this[methodName] = method;
  }
};

BaseModel._properties = {
  name: null,
  schema: null,
};

BaseModel._set_properties = function f(properties) {
  const schema = properties.schema;
  const tableName = schema.table_name || properties.name;

  if (!schemer.validate_table_name(tableName)) {
    throw (buildError('model.tablecreation.invalidname', tableName));
  }

  const qualifiedTableName = util.format('"%s"."%s"', properties.keyspace, tableName);

  this._properties = properties;
  this._properties.table_name = tableName;
  this._properties.qualified_table_name = qualifiedTableName;
  this._driver = new Driver(this._properties);
};

BaseModel._sync_model_definition = function f(callback) {
  const properties = this._properties;
  const tableName = properties.table_name;
  const modelSchema = properties.schema;
  let migration = properties.migration;

  const tableBuilder = new TableBuilder(this._driver, this._properties);

  // backwards compatible change, dropTableOnSchemaChange will work like migration: 'drop'
  if (!migration) {
    if (properties.dropTableOnSchemaChange) migration = 'drop';
    else migration = 'safe';
  }
  // always safe migrate if NODE_ENV==='production'
  if (process.env.NODE_ENV === 'production') migration = 'safe';

  // check for existence of table on DB and if it matches this model's schema
  tableBuilder.get_table_schema((err, dbSchema) => {
    if (err) {
      callback(err);
      return;
    }

    const afterDBCreate = (err1) => {
      if (err1) {
        callback(err1);
        return;
      }

      const indexingTasks = [];

      // cassandra index create if defined
      if (_.isArray(modelSchema.indexes)) {
        tableBuilder.createIndexesAsync = Promise.promisify(tableBuilder.create_indexes);
        indexingTasks.push(tableBuilder.createIndexesAsync(modelSchema.indexes));
      }
      // cassandra custom index create if defined
      if (_.isArray(modelSchema.custom_indexes)) {
        tableBuilder.createCustomIndexesAsync = Promise.promisify(tableBuilder.create_custom_indexes);
        indexingTasks.push(tableBuilder.createCustomIndexesAsync(modelSchema.custom_indexes));
      }
      if (modelSchema.custom_index) {
        tableBuilder.createCustomIndexAsync = Promise.promisify(tableBuilder.create_custom_indexes);
        indexingTasks.push(tableBuilder.createCustomIndexAsync([modelSchema.custom_index]));
      }
      // materialized view create if defined
      if (modelSchema.materialized_views) {
        tableBuilder.createViewsAsync = Promise.promisify(tableBuilder.create_mviews);
        indexingTasks.push(tableBuilder.createViewsAsync(modelSchema.materialized_views));
      }

      Promise.all(indexingTasks)
        .then(() => {
          callback();
        })
        .catch((err2) => {
          callback(err2);
        });
    };

    if (!dbSchema) {
      if (properties.createTable === false) {
        callback(buildError('model.tablecreation.schemanotfound', tableName));
        return;
      }
      // if not existing, it's created
      tableBuilder.create_table(modelSchema, afterDBCreate);
      return;
    }

    let normalizedModelSchema;
    let normalizedDBSchema;

    try {
      normalizedModelSchema = normalizer.normalize_model_schema(modelSchema);
      normalizedDBSchema = normalizer.normalize_model_schema(dbSchema);
    } catch (e) {
      throw (buildError('model.validator.invalidschema', e.message));
    }

    if (_.isEqual(normalizedModelSchema, normalizedDBSchema)) {
      callback();
      return;
    }

    if (migration === 'alter') {
      // check if table can be altered to match schema
      if (_.isEqual(normalizedModelSchema.key, normalizedDBSchema.key) &&
        _.isEqual(normalizedModelSchema.clustering_order, normalizedDBSchema.clustering_order)) {
        tableBuilder.init_alter_operations(modelSchema, dbSchema, normalizedModelSchema, normalizedDBSchema, (err1) => {
          if (err1 && err1.message === 'alter_impossible') {
            tableBuilder.drop_recreate_table(modelSchema, normalizedDBSchema.materialized_views, afterDBCreate);
            return;
          }
          callback(err1);
        });
      } else {
        tableBuilder.drop_recreate_table(modelSchema, normalizedDBSchema.materialized_views, afterDBCreate);
      }
    } else if (migration === 'drop') {
      tableBuilder.drop_recreate_table(modelSchema, normalizedDBSchema.materialized_views, afterDBCreate);
    } else {
      callback(buildError('model.tablecreation.schemamismatch', tableName, 'migration suspended, please apply the change manually'));
    }
  });
};

BaseModel._sync_es_index = function f(callback) {
  const properties = this._properties;

  if (properties.esclient && properties.schema.es_index_mapping) {
    const indexName = properties.keyspace;
    const mappingName = properties.table_name;
    const elassandraBuilder = new ElassandraBuilder(properties.esclient);
    elassandraBuilder.assert_index(indexName, (err) => {
      if (err) {
        callback(err);
        return;
      }
      elassandraBuilder.put_mapping(indexName, mappingName, properties.schema.es_index_mapping, callback);
    });
    return;
  }
  callback();
};

BaseModel._execute_table_query = function f(query, params, options, callback) {
  if (arguments.length === 3) {
    callback = options;
    options = {};
  }

  const defaults = {
    prepare: true,
  };

  options = _.defaultsDeep(options, defaults);

  const doExecuteQuery = function f1(doquery, docallback) {
    this.execute_query(doquery, params, options, docallback);
  }.bind(this, query);

  if (this.is_table_ready()) {
    doExecuteQuery(callback);
  } else {
    this.init((err) => {
      if (err) {
        callback(err);
        return;
      }
      doExecuteQuery(callback);
    });
  }
};

BaseModel._parse_query_object = function f(queryObject) {
  let queryRelations = [];
  let queryParams = [];

  Object.keys(queryObject).forEach((fieldName) => {
    if (fieldName.startsWith('$')) {
      // search queries based on lucene index or solr
      // escape all single quotes for queries in cassandra
      if (fieldName === '$expr') {
        if (typeof queryObject[fieldName].index === 'string' && typeof queryObject[fieldName].query === 'string') {
          queryRelations.push(util.format(
            "expr(%s,'%s')",
            queryObject[fieldName].index, queryObject[fieldName].query.replace(/'/g, "''"),
          ));
        } else {
          throw (buildError('model.find.invalidexpr'));
        }
      } else if (fieldName === '$solr_query') {
        if (typeof queryObject[fieldName] === 'string') {
          queryRelations.push(util.format(
            "solr_query='%s'",
            queryObject[fieldName].replace(/'/g, "''"),
          ));
        } else {
          throw (buildError('model.find.invalidsolrquery'));
        }
      }
      return;
    }

    let whereObject = queryObject[fieldName];
    // Array of operators
    if (!_.isArray(whereObject)) whereObject = [whereObject];

    for (let fk = 0; fk < whereObject.length; fk++) {
      let fieldRelation = whereObject[fk];

      const cqlOperators = {
        $eq: '=',
        $ne: '!=',
        $gt: '>',
        $lt: '<',
        $gte: '>=',
        $lte: '<=',
        $in: 'IN',
        $like: 'LIKE',
        $token: 'token',
        $contains: 'CONTAINS',
        $contains_key: 'CONTAINS KEY',
      };

      if (_.isPlainObject(fieldRelation)) {
        const validKeys = Object.keys(cqlOperators);
        const fieldRelationKeys = Object.keys(fieldRelation);
        for (let i = 0; i < fieldRelationKeys.length; i++) {
          if (!validKeys.includes(fieldRelationKeys[i])) {
            // field relation key invalid, apply default $eq operator
            fieldRelation = { $eq: fieldRelation };
            break;
          }
        }
      } else {
        fieldRelation = { $eq: fieldRelation };
      }

      const relationKeys = Object.keys(fieldRelation);
      for (let rk = 0; rk < relationKeys.length; rk++) {
        const relationKey = relationKeys[rk];
        const relationValue = fieldRelation[relationKey];
        const extractedRelations = parser.extract_query_relations(
          fieldName,
          relationKey,
          relationValue,
          this._properties.schema,
          cqlOperators,
        );
        queryRelations = queryRelations.concat(extractedRelations.queryRelations);
        queryParams = queryParams.concat(extractedRelations.queryParams);
      }
    }
  });

  return {
    queryRelations,
    queryParams,
  };
};

BaseModel._create_where_clause = function f(queryObject) {
  const parsedObject = this._parse_query_object(queryObject);
  const whereClause = {};
  if (parsedObject.queryRelations.length > 0) {
    whereClause.query = util.format('WHERE %s', parsedObject.queryRelations.join(' AND '));
  } else {
    whereClause.query = '';
  }
  whereClause.params = parsedObject.queryParams;
  return whereClause;
};

BaseModel._create_if_clause = function f(queryObject) {
  const parsedObject = this._parse_query_object(queryObject);
  const ifClause = {};
  if (parsedObject.queryRelations.length > 0) {
    ifClause.query = util.format('IF %s', parsedObject.queryRelations.join(' AND '));
  } else {
    ifClause.query = '';
  }
  ifClause.params = parsedObject.queryParams;
  return ifClause;
};

BaseModel._create_find_query = function f(queryObject, options) {
  const orderKeys = [];
  let limit = null;

  Object.keys(queryObject).forEach((k) => {
    const queryItem = queryObject[k];
    if (k.toLowerCase() === '$orderby') {
      if (!(queryItem instanceof Object)) {
        throw (buildError('model.find.invalidorder'));
      }
      const orderItemKeys = Object.keys(queryItem);

      for (let i = 0; i < orderItemKeys.length; i++) {
        const cqlOrderDirection = { $asc: 'ASC', $desc: 'DESC' };
        if (orderItemKeys[i].toLowerCase() in cqlOrderDirection) {
          let orderFields = queryItem[orderItemKeys[i]];

          if (!_.isArray(orderFields)) {
            orderFields = [orderFields];
          }

          for (let j = 0; j < orderFields.length; j++) {
            orderKeys.push(util.format(
              '"%s" %s',
              orderFields[j], cqlOrderDirection[orderItemKeys[i]],
            ));
          }
        } else {
          throw (buildError('model.find.invalidordertype', orderItemKeys[i]));
        }
      }
    } else if (k.toLowerCase() === '$limit') {
      if (typeof queryItem !== 'number') throw (buildError('model.find.limittype'));
      limit = queryItem;
    }
  });

  const whereClause = this._create_where_clause(queryObject);

  let select = '*';
  if (options.select && _.isArray(options.select) && options.select.length > 0) {
    const selectArray = [];
    for (let i = 0; i < options.select.length; i++) {
      // separate the aggregate function and the column name if select is an aggregate function
      const selection = options.select[i].split(/[( )]/g).filter((e) => (e));
      if (selection.length === 1) {
        selectArray.push(util.format('"%s"', selection[0]));
      } else if (selection.length === 2 || selection.length === 4) {
        let functionClause = util.format('%s("%s")', selection[0], selection[1]);
        if (selection[2]) functionClause += util.format(' %s', selection[2]);
        if (selection[3]) functionClause += util.format(' %s', selection[3]);

        selectArray.push(functionClause);
      } else if (selection.length === 3) {
        selectArray.push(util.format('"%s" %s %s', selection[0], selection[1], selection[2]));
      } else {
        selectArray.push('*');
      }
    }
    select = selectArray.join(',');
  }

  let query = util.format(
    'SELECT %s %s FROM "%s" %s %s %s',
    (options.distinct ? 'DISTINCT' : ''),
    select,
    options.materialized_view ? options.materialized_view : this._properties.table_name,
    whereClause.query,
    orderKeys.length ? util.format('ORDER BY %s', orderKeys.join(', ')) : ' ',
    limit ? util.format('LIMIT %s', limit) : ' ',
  );

  if (options.allow_filtering) query += ' ALLOW FILTERING;';
  else query += ';';

  return { query, params: whereClause.params };
};

BaseModel.get_table_name = function f() {
  return this._properties.table_name;
};

BaseModel.get_keyspace_name = function f() {
  return this._properties.keyspace;
};

BaseModel.is_table_ready = function f() {
  return this._ready === true;
};

BaseModel.init = function f(options, callback) {
  if (!callback) {
    callback = options;
    options = undefined;
  }

  this._ready = true;
  callback();
};

BaseModel.syncDB = function f(callback) {
  this._sync_model_definition((err, result) => {
    if (err) {
      callback(err);
      return;
    }

    this._sync_es_index((err1) => {
      if (err1) {
        callback(err1);
        return;
      }

      this._ready = true;
      callback(null, result);
    });
  });
};

BaseModel.get_cql_client = function f(callback) {
  this._driver.ensure_init((err) => {
    if (err) {
      callback(err);
      return;
    }
    callback(null, this._properties.cql);
  });
};

BaseModel.get_es_client = function f() {
  if (!this._properties.esclient) {
    throw (new Error('To use elassandra features, set `manageESIndex` to true in ormOptions'));
  }
  return this._properties.esclient;
};

BaseModel.execute_query = function f(...args) {
  this._driver.execute_query(...args);
};

BaseModel.execute_batch = function f(...args) {
  this._driver.execute_batch(...args);
};

BaseModel.execute_eachRow = function f(...args) {
  this._driver.execute_eachRow(...args);
};

BaseModel._execute_table_eachRow = function f(query, params, options, onReadable, callback) {
  if (this.is_table_ready()) {
    this.execute_eachRow(query, params, options, onReadable, callback);
  } else {
    this.init((err) => {
      if (err) {
        callback(err);
        return;
      }
      this.execute_eachRow(query, params, options, onReadable, callback);
    });
  }
};

BaseModel.eachRow = function f(queryObject, options, onReadable, callback) {
  if (arguments.length === 3) {
    const cb = onReadable;
    onReadable = options;
    callback = cb;
    options = {};
  }
  if (typeof onReadable !== 'function') {
    throw (buildError('model.find.eachrowerror', 'no valid onReadable function was provided'));
  }
  if (typeof callback !== 'function') {
    throw (buildError('model.find.cberror'));
  }

  const defaults = {
    raw: false,
    prepare: true,
  };

  options = _.defaultsDeep(options, defaults);

  options.return_query = true;
  const selectQuery = this.find(queryObject, options);

  const queryOptions = { prepare: options.prepare };
  if (options.consistency) queryOptions.consistency = options.consistency;
  if (options.fetchSize) queryOptions.fetchSize = options.fetchSize;
  if (options.autoPage) queryOptions.autoPage = options.autoPage;
  if (options.hints) queryOptions.hints = options.hints;
  if (options.pageState) queryOptions.pageState = options.pageState;
  if (options.retry) queryOptions.retry = options.retry;
  if (options.serialConsistency) queryOptions.serialConsistency = options.serialConsistency;

  this._execute_table_eachRow(selectQuery.query, selectQuery.params, queryOptions, (n, row) => {
    if (!options.raw) {
      const ModelConstructor = this._properties.get_constructor();
      row = new ModelConstructor(row);
      row._modified = {};
    }
    onReadable(n, row);
  }, (err, result) => {
    if (err) {
      callback(buildError('model.find.dberror', err));
      return;
    }
    callback(err, result);
  });
};

BaseModel.execute_stream = function f(...args) {
  this._driver.execute_stream(...args);
};

BaseModel._execute_table_stream = function f(query, params, options, onReadable, callback) {
  if (this.is_table_ready()) {
    this.execute_stream(query, params, options, onReadable, callback);
  } else {
    this.init((err) => {
      if (err) {
        callback(err);
        return;
      }
      this.execute_stream(query, params, options, onReadable, callback);
    });
  }
};

BaseModel.stream = function f(queryObject, options, onReadable, callback) {
  if (arguments.length === 3) {
    const cb = onReadable;
    onReadable = options;
    callback = cb;
    options = {};
  }

  if (typeof onReadable !== 'function') {
    throw (buildError('model.find.streamerror', 'no valid onReadable function was provided'));
  }
  if (typeof callback !== 'function') {
    throw (buildError('model.find.cberror'));
  }

  const defaults = {
    raw: false,
    prepare: true,
  };

  options = _.defaultsDeep(options, defaults);

  options.return_query = true;
  const selectQuery = this.find(queryObject, options);

  const queryOptions = { prepare: options.prepare };
  if (options.consistency) queryOptions.consistency = options.consistency;
  if (options.fetchSize) queryOptions.fetchSize = options.fetchSize;
  if (options.autoPage) queryOptions.autoPage = options.autoPage;
  if (options.hints) queryOptions.hints = options.hints;
  if (options.pageState) queryOptions.pageState = options.pageState;
  if (options.retry) queryOptions.retry = options.retry;
  if (options.serialConsistency) queryOptions.serialConsistency = options.serialConsistency;

  const self = this;

  this._execute_table_stream(selectQuery.query, selectQuery.params, queryOptions, function f1() {
    const reader = this;
    reader.readRow = () => {
      const row = reader.read();
      if (!row) return row;
      if (!options.raw) {
        const ModelConstructor = self._properties.get_constructor();
        const o = new ModelConstructor(row);
        o._modified = {};
        return o;
      }
      return row;
    };
    onReadable(reader);
  }, (err) => {
    if (err) {
      callback(buildError('model.find.dberror', err));
      return;
    }
    callback();
  });
};

BaseModel.search = function f(queryObject, callback) {
  const esClient = this.get_es_client();
  const query = _.defaults(queryObject, {
    index: this._properties.keyspace,
    type: this._properties.table_name,
  });
  esClient.search(query, (err, response) => {
    if (err) {
      callback(err);
      return;
    }
    callback(null, response);
  });
};

BaseModel.find = function f(queryObject, options, callback) {
  if (arguments.length === 2 && typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (typeof callback !== 'function' && !options.return_query) {
    throw (buildError('model.find.cberror'));
  }

  const defaults = {
    raw: false,
    prepare: true,
  };

  options = _.defaultsDeep(options, defaults);

  // set raw true if select is used,
  // because casting to model instances may lead to problems
  if (options.select) options.raw = true;

  let queryParams = [];

  let query;
  try {
    const findQuery = this._create_find_query(queryObject, options);
    query = findQuery.query;
    queryParams = queryParams.concat(findQuery.params);
  } catch (e) {
    parser.callback_or_throw(e, callback);
    return {};
  }

  if (options.return_query) {
    return { query, params: queryParams };
  }

  const queryOptions = { prepare: options.prepare };
  if (options.consistency) queryOptions.consistency = options.consistency;
  if (options.fetchSize) queryOptions.fetchSize = options.fetchSize;
  if (options.autoPage) queryOptions.autoPage = options.autoPage;
  if (options.hints) queryOptions.hints = options.hints;
  if (options.pageState) queryOptions.pageState = options.pageState;
  if (options.retry) queryOptions.retry = options.retry;
  if (options.serialConsistency) queryOptions.serialConsistency = options.serialConsistency;

  this._execute_table_query(query, queryParams, queryOptions, (err, results) => {
    if (err) {
      callback(buildError('model.find.dberror', err));
      return;
    }
    if (!options.raw) {
      const ModelConstructor = this._properties.get_constructor();
      results = results.rows.map((res) => {
        delete (res.columns);
        const o = new ModelConstructor(res);
        o._modified = {};
        return o;
      });
      callback(null, results);
    } else {
      results = results.rows.map((res) => {
        delete (res.columns);
        return res;
      });
      callback(null, results);
    }
  });

  return {};
};

BaseModel.findOne = function f(queryObject, options, callback) {
  if (arguments.length === 2 && typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (typeof callback !== 'function' && !options.return_query) {
    throw (buildError('model.find.cberror'));
  }

  queryObject.$limit = 1;

  return this.find(queryObject, options, (err, results) => {
    if (err) {
      callback(err);
      return;
    }
    if (results.length > 0) {
      callback(null, results[0]);
      return;
    }
    callback();
  });
};

BaseModel.update = function f(queryObject, updateValues, options, callback) {
  if (arguments.length === 3 && typeof options === 'function') {
    callback = options;
    options = {};
  }

  const schema = this._properties.schema;

  const defaults = {
    prepare: true,
  };

  options = _.defaultsDeep(options, defaults);

  if (typeof schema.before_update === 'function' && schema.before_update(queryObject, updateValues, options) === false) {
    parser.callback_or_throw(buildError('model.update.before.error'), callback);
    return {};
  }

  const { updateClauses, queryParams, errorHappened } = parser.build_update_value_expression(
    this,
    schema,
    updateValues,
    callback,
  );

  if (errorHappened) return {};

  let query = 'UPDATE "%s"';
  let where = '';
  let finalParams = queryParams;
  if (options.ttl) query += util.format(' USING TTL %s', options.ttl);
  query += ' SET %s %s';
  try {
    const whereClause = this._create_where_clause(queryObject);
    where = whereClause.query;
    finalParams = finalParams.concat(whereClause.params);
  } catch (e) {
    parser.callback_or_throw(e, callback);
    return {};
  }

  query = util.format(query, this._properties.table_name, updateClauses.join(', '), where);

  if (options.conditions) {
    const ifClause = this._create_if_clause(options.conditions);
    if (ifClause.query) {
      query += util.format(' %s', ifClause.query);
      finalParams = finalParams.concat(ifClause.params);
    }
  } else if (options.if_exists) {
    query += ' IF EXISTS';
  }

  query += ';';

  if (options.return_query) {
    const returnObj = {
      query,
      params: finalParams,
      after_hook: () => {
        if (typeof schema.after_update === 'function' && schema.after_update(queryObject, updateValues, options) === false) {
          return buildError('model.update.after.error');
        }
        return true;
      },
    };
    return returnObj;
  }

  const queryOptions = { prepare: options.prepare };
  if (options.consistency) queryOptions.consistency = options.consistency;
  if (options.fetchSize) queryOptions.fetchSize = options.fetchSize;
  if (options.autoPage) queryOptions.autoPage = options.autoPage;
  if (options.hints) queryOptions.hints = options.hints;
  if (options.pageState) queryOptions.pageState = options.pageState;
  if (options.retry) queryOptions.retry = options.retry;
  if (options.serialConsistency) queryOptions.serialConsistency = options.serialConsistency;

  this._execute_table_query(query, finalParams, queryOptions, (err, results) => {
    if (typeof callback === 'function') {
      if (err) {
        callback(buildError('model.update.dberror', err));
        return;
      }
      if (typeof schema.after_update === 'function' && schema.after_update(queryObject, updateValues, options) === false) {
        callback(buildError('model.update.after.error'));
        return;
      }
      callback(null, results);
    } else if (err) {
      throw (buildError('model.update.dberror', err));
    } else if (typeof schema.after_update === 'function' && schema.after_update(queryObject, updateValues, options) === false) {
      throw (buildError('model.update.after.error'));
    }
  });

  return {};
};

BaseModel.delete = function f(queryObject, options, callback) {
  if (arguments.length === 2 && typeof options === 'function') {
    callback = options;
    options = {};
  }

  const schema = this._properties.schema;

  const defaults = {
    prepare: true,
  };

  options = _.defaultsDeep(options, defaults);

  if (typeof schema.before_delete === 'function' && schema.before_delete(queryObject, options) === false) {
    parser.callback_or_throw(buildError('model.delete.before.error'), callback);
    return {};
  }

  let queryParams = [];

  let query = 'DELETE FROM "%s" %s;';
  let where = '';
  try {
    const whereClause = this._create_where_clause(queryObject);
    where = whereClause.query;
    queryParams = queryParams.concat(whereClause.params);
  } catch (e) {
    parser.callback_or_throw(e, callback);
    return {};
  }

  query = util.format(query, this._properties.table_name, where);

  if (options.return_query) {
    const returnObj = {
      query,
      params: queryParams,
      after_hook: () => {
        if (typeof schema.after_delete === 'function' && schema.after_delete(queryObject, options) === false) {
          return buildError('model.delete.after.error');
        }
        return true;
      },
    };
    return returnObj;
  }

  const queryOptions = { prepare: options.prepare };
  if (options.consistency) queryOptions.consistency = options.consistency;
  if (options.fetchSize) queryOptions.fetchSize = options.fetchSize;
  if (options.autoPage) queryOptions.autoPage = options.autoPage;
  if (options.hints) queryOptions.hints = options.hints;
  if (options.pageState) queryOptions.pageState = options.pageState;
  if (options.retry) queryOptions.retry = options.retry;
  if (options.serialConsistency) queryOptions.serialConsistency = options.serialConsistency;

  this._execute_table_query(query, queryParams, queryOptions, (err, results) => {
    if (typeof callback === 'function') {
      if (err) {
        callback(buildError('model.delete.dberror', err));
        return;
      }
      if (typeof schema.after_delete === 'function' && schema.after_delete(queryObject, options) === false) {
        callback(buildError('model.delete.after.error'));
        return;
      }
      callback(null, results);
    } else if (err) {
      throw (buildError('model.delete.dberror', err));
    } else if (typeof schema.after_delete === 'function' && schema.after_delete(queryObject, options) === false) {
      throw (buildError('model.delete.after.error'));
    }
  });

  return {};
};

BaseModel.truncate = function f(callback) {
  const properties = this._properties;
  const tableName = properties.table_name;

  const query = util.format('TRUNCATE TABLE "%s";', tableName);
  this._execute_table_query(query, [], callback);
};

BaseModel.prototype.get_data_types = function f() {
  return cql.types;
};

BaseModel.prototype.get_table_name = function f() {
  return this.constructor.get_table_name();
};

BaseModel.prototype.get_keyspace_name = function f() {
  return this.constructor.get_keyspace_name();
};

BaseModel.prototype._get_default_value = function f(fieldname) {
  const properties = this.constructor._properties;
  const schema = properties.schema;

  if (_.isPlainObject(schema.fields[fieldname]) && schema.fields[fieldname].default !== undefined) {
    if (typeof schema.fields[fieldname].default === 'function') {
      return schema.fields[fieldname].default.call(this);
    }
    return schema.fields[fieldname].default;
  }
  return undefined;
};

BaseModel.prototype.validate = function f(propertyName, value) {
  value = value || this[propertyName];
  this._validators = this._validators || {};
  return schemer.get_validation_message(this._validators[propertyName] || [], value);
};

BaseModel.prototype.save = function fn(options, callback) {
  if (arguments.length === 1 && typeof options === 'function') {
    callback = options;
    options = {};
  }

  const properties = this.constructor._properties;
  const schema = properties.schema;

  const defaults = {
    prepare: true,
  };

  options = _.defaultsDeep(options, defaults);

  if (typeof schema.before_save === 'function' && schema.before_save(this, options) === false) {
    parser.callback_or_throw(buildError('model.save.before.error'), callback);
    return {};
  }

  const {
    identifiers,
    values,
    queryParams,
    errorHappened,
  } = parser.build_save_value_expression(this, schema, callback);

  if (errorHappened) return {};

  let query = util.format(
    'INSERT INTO "%s" ( %s ) VALUES ( %s )',
    properties.table_name,
    identifiers.join(' , '),
    values.join(' , '),
  );

  if (options.if_not_exist) query += ' IF NOT EXISTS';
  if (options.ttl) query += util.format(' USING TTL %s', options.ttl);

  query += ';';

  if (options.return_query) {
    const returnObj = {
      query,
      params: queryParams,
      after_hook: () => {
        if (typeof schema.after_save === 'function' && schema.after_save(this, options) === false) {
          return buildError('model.save.after.error');
        }
        return true;
      },
    };
    return returnObj;
  }

  const queryOptions = { prepare: options.prepare };
  if (options.consistency) queryOptions.consistency = options.consistency;
  if (options.fetchSize) queryOptions.fetchSize = options.fetchSize;
  if (options.autoPage) queryOptions.autoPage = options.autoPage;
  if (options.hints) queryOptions.hints = options.hints;
  if (options.pageState) queryOptions.pageState = options.pageState;
  if (options.retry) queryOptions.retry = options.retry;
  if (options.serialConsistency) queryOptions.serialConsistency = options.serialConsistency;

  this.constructor._execute_table_query(query, queryParams, queryOptions, (err, result) => {
    if (typeof callback === 'function') {
      if (err) {
        callback(buildError('model.save.dberror', err));
        return;
      }
      if (!options.if_not_exist || (result.rows && result.rows[0] && result.rows[0]['[applied]'])) {
        this._modified = {};
      }
      if (typeof schema.after_save === 'function' && schema.after_save(this, options) === false) {
        callback(buildError('model.save.after.error'));
        return;
      }
      callback(null, result);
    } else if (err) {
      throw (buildError('model.save.dberror', err));
    } else if (typeof schema.after_save === 'function' && schema.after_save(this, options) === false) {
      throw (buildError('model.save.after.error'));
    }
  });

  return {};
};

BaseModel.prototype.delete = function f(options, callback) {
  if (arguments.length === 1 && typeof options === 'function') {
    callback = options;
    options = {};
  }

  const schema = this.constructor._properties.schema;
  const deleteQuery = {};

  for (let i = 0; i < schema.key.length; i++) {
    const fieldKey = schema.key[i];
    if (_.isArray(fieldKey)) {
      for (let j = 0; j < fieldKey.length; j++) {
        deleteQuery[fieldKey[j]] = this[fieldKey[j]];
      }
    } else {
      deleteQuery[fieldKey] = this[fieldKey];
    }
  }

  return this.constructor.delete(deleteQuery, options, callback);
};

BaseModel.prototype.toJSON = function toJSON() {
  const object = {};
  const schema = this.constructor._properties.schema;

  Object.keys(schema.fields).forEach((field) => {
    object[field] = this[field];
  });

  return object;
};

BaseModel.prototype.isModified = function isModified(propName) {
  if (propName) {
    return Object.prototype.hasOwnProperty.call(this._modified, propName);
  }
  return Object.keys(this._modified).length !== 0;
};

module.exports = BaseModel;

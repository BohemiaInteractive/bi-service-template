const https        = require('https');
const Promise      = require('bluebird');
const path         = require('path');
const fs           = Promise.promisifyAll(require('fs'));
const Prompt       = require('inquirer');
const mustache     = require('mustache');
const _            = require('lodash');
const json5        = require('json5');
const childProcess = require('child_process');

const questions  = require('./questions.js');
const plugins    = require('./plugins.json');
const licenses   = require('./licenses.json');

Prompt.registerPrompt('autocomplete', require('inquirer-autocomplete-prompt'));

module.exports = Template;
module.exports.Template = Template;

/**
 * @public
 * @constructor
 */
function Template() {
    this.CLI = null;

    this.defaults = {
        scripts: {
            start: "./node_modules/.bin/bi-service run",
        },
        private: true,
        main: 'index.js',
        files: [
            'CHANGELOG.md',
            'README.md',
            'LICENSE',
            'index.js',
            'lib',
            'bin'
        ],
        engines: {
            node: `>=${process.version.slice(1)}`
        },
        contributors: [],
        dependencies: {},
        devDependencies: {},
        peerDependencies: {}
    };
}

/**
 * @param {Object} argv
 * @return {Promise}
 */
Template.prototype.initCmd = Promise.method(function(argv) {
    let pkg, config, dependencies;

    //return fs.readFileAsync('/tmp/answers.json').bind(this).then(function(answers) {
        //answers = JSON.parse(answers.toString());
        //dependencies = normalizeProjectDependencies(answers._dependencies);
        //config = normalizeProjectConfig(answers._config);
        //pkg = extractNpmPackage(answers);
    //});

    return this._getAnswers().bind(this).then(function(answers) {
        dependencies = normalizeProjectDependencies(answers._dependencies);
        config = normalizeProjectConfig(answers._config);
        pkg = extractNpmPackage(answers);

        if (pkg.license !== 'None') {
            return getLicense(pkg.license);
        }
        return null;
    }).then(function(license) {
        return this.create(pkg, config, dependencies, license);
    }).then(function() {
        return npmInstall(dependencies.dependencies, ['--save']);
    }).then(function() {
        return npmInstall(dependencies.devDependencies, ['--save-dev']);
    });
});


/**
 * @param {Object} package
 * @param {Object} config
 * @param {Object} dependencies
 *
 * @return {Promise}
 */
Template.prototype.create = function(package, config, dependencies, license) {
    let appContext = _.reduce(config.apps, function(out, val, app) {
        if (!~['cli'].indexOf(app)) {
            out.apps.push(app);
        }
        return out;
    }, {apps: []});

    let directories = [
        process.cwd() + '/lib',
        process.cwd() + '/lib/validation',
        process.cwd() + '/lib/routes',
        process.cwd() + '/lib/routes/v1.0',
        process.cwd() + '/config',
        process.cwd() + '/config/development',
        process.cwd() + '/test',
    ];

    let templates = [
        {
            path: path.resolve(process.cwd() + '/package.json'),
            data: this._render('package', package)
        },
        {
            path: path.resolve(process.cwd() + '/config/development/config.json5'),
            data: this._render('config', config, {json5: true})
        },
        {
            path: path.resolve(process.cwd() + '/index.js'),
            data: this._render('index', {
                package: Object.assign({}, package, {
                    dependencies: dependencies.dependencies,
                    devDependencies: dependencies.devDependencies
                }),
                config: config
            })
        },
        {
            path: path.resolve(process.cwd() + '/LICENSE'),
            data: this._render('LICENSE', {
                license: license || ''
            })
        },
        {
            path: path.resolve(process.cwd() + '/CHANGELOG.md'),
            data: this._render('CHANGELOG')
        },
        {
            path: path.resolve(process.cwd() + '/lib/app.js'),
            data: this._render('app', appContext)
        },
        {
            path: path.resolve(process.cwd() + '/.gitignore'),
            data: this._render('gitignore')
        },
        {
            path: path.resolve(process.cwd() + '/.npmignore'),
            data: this._render('npmignore')
        },
        {
            path: path.resolve(process.cwd() + '/test/test.js'),
            data: this._render('test')
        },
    ];

    if (   config.hasOwnProperty('sequelize')
        || _.has(config, 'storage.couchbase')
    ) {
        directories.push(process.cwd() + '/lib/database');
        directories.push(process.cwd() + '/lib/models');

        if (config.hasOwnProperty('sequelize')) {
            directories.push(process.cwd() + '/lib/models/orm');
            templates.push({
                path: path.resolve(process.cwd() + '/lib/database/sequelize.js'),
                data: this._render('sequelize')
            });
        }

        if (_.has(config, 'storage.couchbase')) {
            directories.push(process.cwd() + '/lib/models/odm');
            templates.push({
                path: path.resolve(process.cwd() + '/lib/database/couchbase.js'),
                data: this._render('couchbase')
            });
        }
    }

    appContext.apps.forEach(function(appName) {
        directories.push(process.cwd() + `/lib/routes/v1.0/${appName}`);
        directories.push(process.cwd() + `/lib/routes/v1.0/${appName}/example`);
        directories.push(process.cwd() + `/lib/routes/v1.0/${appName}/example/routes`);

        templates.push({
            path: path.resolve(process.cwd() + `/lib/routes/v1.0/${appName}/example/router.js`),
            data: this._render('router', {app: appName})
        });
        templates.push({
            path: path.resolve(process.cwd() + `/lib/routes/v1.0/${appName}/example/routes/get.js`),
            data: this._render('route')
        });
    }, this);

    //create directories
    directories.forEach(function(dir) {
        return fs.mkdirSync(path.resolve(dir));
    });

    return Promise.map(templates, function(template) {
        console.info(`Creating ${template.path.slice(process.cwd().length + 1)}`);
        return fs.writeFileAsync(template.path, template.data);
    });
};

/**
 * @private
 * @return {Object}
 */
Template.prototype._getAnswers = Promise.method(function() {
    return Promise.reduce(questions, function(answers, questionGetter) {
        return Prompt.prompt(questionGetter(answers)).then(function(_answers) {
            return _.merge(answers, _answers);
        });
    }, this.defaults);
});

/**
 * @param {String} name
 * @param {Object} data - template context data
 * @param {Object} options
 * @param {Bolean} options.json5
 *
 * @return {String}
 */
Template.prototype._render = function(name, data, options) {
    options = options || {};

    const tmpl = fs.readFileSync(
        path.resolve(__dirname + `/templates/${name}.mustache`)
    );

    let context = _.reduce(data, function(out, value, key) {
        out['_' + key] = value;

        if (options.json5) {
            out[key] = new Function(`return \`${json5.stringify(value, null, 4)}\`;`);
        } else {
            out[key] = new Function(`return JSON.stringify(this['_${key}'], null, 4);`);
        }
        return out;
    }, {});

    return mustache.render(tmpl.toString(), context);
};

/**
 * @param {Array<String>} dependencies - optional user defined dependencies
 * @return {Object}
 */
function normalizeProjectDependencies(dependencies) {
    dependencies = dependencies || [];

    return dependencies.reduce(function(out, dep) {
        if (plugins.hasOwnProperty(dep)) {
            if (plugins[dep].dev) {
                out.devDependencies[dep] = '*';
            } else {
                out.dependencies[dep] = '*';
            }
        }
        return out;
    }, {
        dependencies: {
            'bi-service': '*',
            bluebird: '*',
            lodash: '*'
        },
        devDependencies: {}
    });
}

/**
 * @param {Object} config
 * @return {Object}
 */
function normalizeProjectConfig(config) {
    const out = {
        listen: config.listen,
        storage: config.storage || {},
        apps: {}
    };

    //normalize config.storage.mysql/postgres
    if (config._sqlProvider) {
        out.storage[config._sqlProvider] = {
            host: config._sqlHost,
            ssl: false,
            databases: {
                main: {
                    db: config._sqlDatabase,
                    username: config._sqlUsername,
                    password: config._sqlPassword,
                }
            }
        };

        //
        out.sequelize = {
            cache    : false,
            dialect  : config._sqlProvider,
            host     : {$ref: `#/storage/${config._sqlProvider}/host`},
            port     : {$ref: `#/storage/${config._sqlProvider}/port`},
            ssl      : {$ref: `#/storage/${config._sqlProvider}/ssl`},
            db       : {$ref: `#/storage/${config._sqlProvider}/databases/main/db`},
            username : {$ref: `#/storage/${config._sqlProvider}/databases/main/username`},
            password : {$ref: `#/storage/${config._sqlProvider}/databases/main/password`},
        };
    }

    //normalize config.apps
    (config._apps || []).filter(function(appName) {
        return !~appName.indexOf('-doc');
    }).forEach(function(appName) {
        out.apps[appName] = {
            baseUrl: {$join: [
                config._host + ':',
                {$ref: `#/listen/${appName}/port`}
            ]},
            stopOnError: false,
            bodyParser: {$ref: '#/bodyParser'},
            listen: {$ref: `#/listen/${appName}/port`},
            response: {$ref: '#/response'},
        };

        if (   config._apps instanceof Array
            && config._apps.indexOf(`${appName}-doc`) !== -1
        ) {
            out.apps[appName].doc = {
                baseUrl: {$join: [
                    config._host + ':',
                    {$ref: `#/listen/${appName}-doc/port`}
                ]},
                listen: {$ref: `#/listen/${appName}-doc/port`},
                name: 'docs',
                title: 'Docs',
                stopOnError: true,
                tryItOut: false
            };
        }
    });

    return out;
}

/**
 * @param {Object} answers
 * @return {Object}
 */
function extractNpmPackage(answers) {
    return _.reduce(answers, function(out, value, key) {
        if (!key.match(/^_.+$/)) {
            out[key] = _.cloneDeep(value);
        }

        return out;
    }, {});
}

/**
 * @param {String} name
 * @return {String}
 */
function getLicense(name) {
    const license = _.find(licenses, ['name', name]);

    return new Promise(function(resolve, reject) {
        let req = https.get({
            host: 'api.github.com',
            path: `/licenses/${license.key}`,
            headers: {
                Accept: 'application/vnd.github.drax-preview+json',
                'User-Agent': 'NodeJS'
            },
            method: 'GET'
        }, function(res) {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', function (chunk) {
                data += chunk.toString();
            });

            res.on('end', function() {
                if (res.statusCode !== 200 && res.statusCode !== 302) {
                    return reject(
                        new Error(`Response status code: ${res.statusCode}. ${data}`)
                    );
                }

                return resolve(JSON.parse(data));
            });
        });

        req.once('error', reject);
        req.end();
    });
}

/**
 * @param {Object} dependencies
 * @param {Array<String>} args - optional npm install arguments
 * @return {Promise}
 */
function npmInstall(dependencies, args) {
    args = _.clone(args) || [];

    return new Promise(function(resolve, reject) {
        args = args.concat(Object.keys(dependencies));

        args.unshift('install');

        let npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

        let proc = childProcess.spawn(npmCmd, args, {cwd: process.cwd()});

        let stderr = '';
        proc.stdout.on('data', function(data) {
            //if (vLevel > 2) {
                //console.info(data.toString());
            //}
        });
        proc.stderr.on('data', function(data) {
            stderr += data.toString();
            //if (vLevel > 2) {
                //console.info(data.toString());
            //}
        });
        proc.on('close', function(code) {
            if (code !== 0) {
                return reject(new Error(stderr));
            }

            return resolve();
        });
    });
}
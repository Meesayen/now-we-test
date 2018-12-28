/* eslint-disable import/no-dynamic-require,global-require,no-console */
const { existsSync } = require('fs')
const path = require('path')
const mri = require('mri')
const minimatch = require('minimatch')
const invariant = require('invariant')
const micro = require('micro')
const Regex = require('named-regexp-groups')
const morgan = require('morgan')
const clearModule = require('clear-module')

const { createError } = micro

const lamdbaMap = new Map()

module.exports = async (argv) => {
  const args = mri(argv, {
    alias: {
      p: 'port',
      f: ['format']
    },
    default: {
      port: process.env.PORT || 3000,
      format: 'combined'
    }
  })

  const [basePath = '.'] = args._

  const rootPath = path.resolve(process.cwd(), basePath)
  const projectPaths = new Regex(`${rootPath}/.*`)
  const nowConfigPath = path.resolve(rootPath, 'now.json')
  invariant(existsSync(nowConfigPath), `No now.json found at ${nowConfigPath}`)

  console.debug(`using ${nowConfigPath}`)

  const { builds = [], routes = [] } = require(nowConfigPath)

  // find all node lambdas
  const nodeBuilds = builds.filter(({ use }) => /^@now\/node@?/.test(use))
  invariant(nodeBuilds.length > 0, 'No @now/node builds found')

  const httpLogger = morgan(args.format)

  const app = micro((req, res, ...args) => {
    const urls = [req.url]

    if (routes.length) {
      const route = routes.find(({ src }) =>
        req.url.match(src.replace(/\(\?<[a-z]+>/, '('))
      )

      if (route) {
        const captGroups = []

        // see https://stackoverflow.com/a/11443943
        route.src.replace(/\(\?<([a-z]+)>/gi, (match, id) => {
          captGroups.push(id)
        })

        // @TODO: should normalize dest to PCRE complient backreferences
        // see: http://perldoc.perl.org/perlretut.html#Named-backreferences
        urls.push(
          req.url.replace(
            new Regex(route.src),
            captGroups.reduce(
              (dest, id) => dest.replace(new RegExp('\\$' + id), `$+{${id}}`),
              route.dest
            )
          )
        )
      }
    }

    const pathname = urls
      .map(
        url =>
          `${url
            .replace(/^\//, '')
            .replace(/\?.*?(\..*)$/, '$1')
            .replace(/(\.[tj]s)\1$/, '$1')
            .replace(/...$/, sub => {
              if (/^\.[tj]s$/.test(sub)) return sub
              // we can't infer the type at this point, let's go with .js
              return `${sub}.js`
            })}`
      )

      .find((value, i) => nodeBuilds.find(({ src }) => minimatch(value, src)))

    if (!pathname) {
      throw createError(404, 'No lambda matching requested path')
    }

    const targetPath = path.resolve(rootPath, pathname)

    // Handle not-found paths.
    if (!existsSync(targetPath)) {
      throw createError(404, 'Expected lambda file not found')
    }

    clearModule.match(projectPaths)

    if (!lamdbaMap.has(targetPath)) {
      lamdbaMap.set(targetPath, require(targetPath))
    }
    let lambda = lamdbaMap.get(targetPath)
    if (targetPath.endsWith('.ts')) {
      lambda = lambda.default
    }

    invariant(typeof lambda === 'function', 'Lambdas must be functions')

    return new Promise(resolve => {
      httpLogger(req, res, err => {
        if (err) throw err

        resolve(lambda(req, res, ...args))
      })
    })
  })

  app.listen(args.port, () =>
    console.log(`Serving lambdas at http://localhost:${args.port}`)
  )

  return app
}

/* eslint-disable no-extra-semi */
/* eslint-disable no-case-declarations */
/* eslint-disable prefer-const */
import type { Elysia } from 'elysia'
import type { Treaty } from './types'
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios'

import { EdenFetchError } from '../errors'
import { EdenWS } from './ws'
import { parseStringifiedValue } from '../utils/parsingUtils'

const method = [
	'get',
	'post',
	'put',
	'delete',
	'patch',
	'options',
	'head',
	'connect',
	'subscribe'
] as const

const locals = ['localhost', '127.0.0.1', '0.0.0.0']

const isServer = typeof FileList === 'undefined'

const isFile = (v: any) => {
	if (isServer) return v instanceof Blob

	return v instanceof FileList || v instanceof File
}

// FormData is 1 level deep
const hasFile = (obj: Record<string, any>) => {
	if (!obj) return false

	for (const key in obj) {
		if (isFile(obj[key])) return true

		if (Array.isArray(obj[key]) && (obj[key] as unknown[]).find(isFile))
			return true
	}

	return false
}

const createNewFile = (v: File) =>
	isServer
		? v
		: new Promise<File>((resolve) => {
				const reader = new FileReader()

				reader.onload = () => {
					const file = new File([reader.result!], v.name, {
						lastModified: v.lastModified,
						type: v.type
					})
					resolve(file)
				}

				reader.readAsArrayBuffer(v)
			})

const processHeaders = (
	h: Treaty.Config['headers'],
	path: string,
	options: AxiosRequestConfig = {},
	headers: Record<string, string> = {}
): Record<string, string> => {
	if (Array.isArray(h)) {
		for (const value of h)
			if (!Array.isArray(value))
				headers = processHeaders(value, path, options, headers)
			else {
				const key = value[0]
				if (typeof key === 'string')
					headers[key.toLowerCase()] = value[1] as string
				else
					for (const [k, value] of key)
						headers[k.toLowerCase()] = value as string
			}

		return headers
	}

	if (!h) return headers

	switch (typeof h) {
		case 'function':
			if (h instanceof Headers)
				return processHeaders(h, path, options, headers)

			const v = h(path, options)
			if (v) return processHeaders(v, path, options, headers)
			return headers

		case 'object':
			if (h instanceof Headers) {
				h.forEach((value, key) => {
					headers[key.toLowerCase()] = value
				})
				return headers
			}

			for (const [key, value] of Object.entries(h))
				headers[key.toLowerCase()] = value as string

			return headers

		default:
			return headers
	}
}

export async function* streamResponse(response: AxiosResponse) {
	const body = response.data

	if (!body) return

	if (typeof body === 'string') {
		yield parseStringifiedValue(body)
		return
	}

	// Handle streaming response if needed
	if (body.pipe) {
		const stream = body
		const chunks: Buffer[] = []
		
		for await (const chunk of stream) {
			yield parseStringifiedValue(chunk.toString())
		}
	}
}

const createProxy = (
	domain: string,
	config: Treaty.Config,
	paths: string[] = [],
	elysia?: Elysia<any, any, any, any, any, any>
): any =>
	new Proxy(() => {}, {
		get(_, param: string): any {
			return createProxy(
				domain,
				config,
				param === 'index' ? paths : [...paths, param],
				elysia
			)
		},
		apply(_, __, [body, options]) {
			if (
				!body ||
				options ||
				(typeof body === 'object' && Object.keys(body).length !== 1) ||
				method.includes(paths.at(-1) as any)
			) {
				const methodPaths = [...paths]
				const method = methodPaths.pop()
				const path = '/' + methodPaths.join('/')

				let {
					axiosInstance = axios.create(),
					headers,
					onRequest,
					onResponse,
					axios: conf
				} = config

				const isGetOrHead =
					method === 'get' ||
					method === 'head' ||
					method === 'subscribe'

				headers = processHeaders(headers, path, options)

				const query = isGetOrHead
					? (body as Record<string, string | string[] | undefined>)
							?.query
					: options?.query

				let q = ''
				if (query) {
					const append = (key: string, value: string) => {
						q +=
							(q ? '&' : '?') +
							`${encodeURIComponent(key)}=${encodeURIComponent(
								value
							)}`
					}

					for (const [key, value] of Object.entries(query)) {
						if (Array.isArray(value)) {
							for (const v of value) append(key, v)
							continue
						}

						if (typeof value === 'object') {
							append(key, JSON.stringify(value))
							continue
						}
							
				
						append(key, `${value}`)
					}
				}

				if (method === 'subscribe') {
					const url =
						domain.replace(
							/^([^]+):\/\//,
							domain.startsWith('https://')
								? 'wss://'
								: domain.startsWith('http://')
									? 'ws://'
									: locals.find((v) =>
												(domain as string).includes(v)
										  )
										? 'ws://'
										: 'wss://'
						) +
						path +
						q

					return new EdenWS(url)
				}

				return (async () => {
					let axiosConfig: AxiosRequestConfig = {
						method: method?.toUpperCase(),
						data: body,
						...conf,
						headers
					}

					axiosConfig.headers = {
						...headers,
						...processHeaders(
							isGetOrHead ? body?.headers : options?.headers,
							path,
							axiosConfig
						)
					}

					const fetchOpts =
						isGetOrHead && typeof body === 'object'
							? body.axios
							: options?.axios

					axiosConfig = {
						...axiosConfig,
						...fetchOpts
					}

					if (isGetOrHead) delete axiosConfig.data

					if (onRequest) {
						if (!Array.isArray(onRequest)) onRequest = [onRequest]

						for (const value of onRequest) {
							const temp = await value(path, axiosConfig)

							if (typeof temp === 'object')
								axiosConfig = {
									...axiosConfig,
									...temp,
									headers: {
										...axiosConfig.headers,
										...processHeaders(
											temp.headers,
											path,
											axiosConfig
										)
									}
								}
						}
					}

					if (isGetOrHead) delete axiosConfig.data

					if (hasFile(body)) {
						const formData = new FormData()

						for (const [key, field] of Object.entries(
							axiosConfig.data
						)) {
							if (isServer) {
								formData.append(key, field as any)

								continue
							}

							if (field instanceof File) {
								formData.append(
									key,
									await createNewFile(field as any)
								)

								continue
							}

							if (field instanceof FileList) {
								for (let i = 0; i < field.length; i++)
									formData.append(
										key as any,
										await createNewFile((field as any)[i])
									)

								continue
							}

							if (Array.isArray(field)) {
								for (let i = 0; i < field.length; i++) {
									const value = (field as any)[i]

									formData.append(
										key as any,
										value instanceof File
											? await createNewFile(value)
											: value
									)
								}

								continue
							}

							formData.append(key, field as string)
						}

						axiosConfig.data = formData
						axiosConfig.headers = {
							...axiosConfig.headers,
							'Content-Type': 'multipart/form-data'
						}
					} else if (typeof body === 'object') {
						axiosConfig.headers = {
							...axiosConfig.headers,
							'Content-Type': 'application/json'
						}
						axiosConfig.data = body
					} else if (body !== undefined && body !== null) {
						axiosConfig.headers = {
							...axiosConfig.headers,
							'Content-Type': 'text/plain'
						}
						axiosConfig.data = body
					}

					if (isGetOrHead) delete axiosConfig.data

					const url = domain + path + q
					let response: AxiosResponse
					
					try {
						if (elysia) {
							// Handle Elysia instance case
							const elyResponse = await elysia.handle(new Request(url, {
								method: axiosConfig.method,
								headers: axiosConfig.headers as HeadersInit,
								body: axiosConfig.data ? JSON.stringify(axiosConfig.data) : undefined
							}))
							
							// Convert Response to AxiosResponse format
							const responseHeaders: Record<string, string> = {};
							elyResponse.headers.forEach((value, key) => {
								responseHeaders[key] = value;
							});
							
							response = {
								data: await elyResponse.json(),
								status: elyResponse.status,
								statusText: elyResponse.statusText,
								headers: responseHeaders,
								config: axiosConfig as any, // Force type to avoid circular reference
								request: undefined
							}
						} else {
							response = await axiosInstance({
								url,
								...axiosConfig,
								headers: axiosConfig.headers || {}
							})
						}
					} catch (error) {
						if (axios.isAxiosError(error) && error.response) {
							response = error.response
						} else {
							throw error
						}
					}

					let data: AsyncGenerator<any, void, unknown> | ArrayBuffer | FormData | Record<string, any> | string | null = null
					let error = null

					if (onResponse) {
						if (!Array.isArray(onResponse))
							onResponse = [onResponse]

						for (const value of onResponse)
							try {
								const temp = await value(response)

								if (temp !== undefined && temp !== null) {
									data = temp
									break
								}
							} catch (err) {
								if (err instanceof EdenFetchError) error = err
								else error = new EdenFetchError(422, err)

								break
							}
					}

					if (data !== null) {
						return {
							data,
							error,
							response,
							status: response.status,
							headers: response.headers
						}
					}

					const contentType = response.headers['content-type']?.split(';')[0]

					switch (contentType) {
						case 'text/event-stream':
							data = streamResponse(response)
							break

						case 'application/json':
							data = response.data
							break

						case 'application/octet-stream':
							data = response.data
							break

						case 'multipart/form-data':
							data = {}
							if (response.data instanceof FormData) {
								response.data.forEach((value, key) => {
									// @ts-ignore
									data[key] = value
								})
							}
							break

						default:
							data = typeof response.data === 'string' 
								? parseStringifiedValue(response.data)
								: response.data
					}

					if (response.status >= 300 || response.status < 200) {
						error = new EdenFetchError(response.status, data)
						data = null
					}

					return {
						data,
						error,
						response,
						status: response.status,
						headers: response.headers
					}
				})()
			}

			if (typeof body === 'object')
				return createProxy(
					domain,
					config,
					[...paths, Object.values(body)[0] as string],
					elysia
				)

			return createProxy(domain, config, paths)
		}
	}) as any

export const treaty = <
	const App extends Elysia<any, any, any, any, any, any, any, any>
>(
	domain: string | App,
	config: Treaty.Config = {}
): Treaty.Create<App> => {
	if (typeof domain === 'string') {
		if (!config.keepDomain) {
			if (!domain.includes('://'))
				domain =
					(locals.find((v) => (domain as string).includes(v))
						? 'http://'
						: 'https://') + domain

			if (domain.endsWith('/')) domain = domain.slice(0, -1)
		}

		return createProxy(domain, config)
	}

	if (typeof window !== 'undefined')
		console.warn(
			'Elysia instance server found on client side, this is not recommended for security reason. Use generic type instead.'
		)

	return createProxy('http://e.ly', config, [], domain)
}

export type { Treaty }

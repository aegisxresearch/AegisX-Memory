import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DECLARATION_KINDS, extractSymbols } from '../src/indexer/indexer.js';
import { Engine } from '../src/core/engine.js';

/** Declarations only — markers and imports are asserted elsewhere. */
function decls(filePath: string, lines: string[]): string[] {
  return extractSymbols(filePath, lines.join('\n'))
    .filter((s) => DECLARATION_KINDS.includes(s.kind))
    .map((s) => `${s.kind} ${s.name}`);
}

describe('symbols — one declaration family per language', () => {
  it('Java: class, interface, enum and record declarations', () => {
    expect(
      decls('src/main/java/shop/UserService.java', [
        'package com.shop.users;',
        '',
        'public class UserService {',
        '    private final UserRepo repo;',
        '}',
        '',
        'public interface UserRepo {',
        '    User get(long id);',
        '}',
        '',
        'public enum Role { ADMIN, USER }',
        '',
        'public record Point(int x, int y) {}',
      ]),
    ).toEqual(['class UserService', 'interface UserRepo', 'enum Role', 'record Point']);
  });

  it('C#: file-scoped namespace, class, record, interface and enum', () => {
    expect(
      decls('src/Shop/OrderService.cs', [
        'using System;',
        '',
        'namespace Shop.Core;',
        '',
        'public class OrderService',
        '{',
        '}',
        '',
        'public record Order(string Sku);',
        '',
        'public interface IOrderRepo',
        '{',
        '}',
        '',
        'public enum Status',
        '{',
        '    Open,',
        '    Closed,',
        '}',
      ]),
    ).toEqual([
      'namespace Shop.Core',
      'class OrderService',
      'record Order',
      'interface IOrderRepo',
      'enum Status',
    ]);
  });

  it('Kotlin: data/sealed/open class, object, interface and top-level fun', () => {
    expect(
      decls('src/UserService.kt', [
        'package shop.users',
        '',
        'data class User(val id: Long)',
        '',
        'sealed class Result',
        '',
        'object AppConfig',
        '',
        'interface Repository',
        '',
        'fun main(args: Array<String>) {',
        '    println("hi")',
        '}',
        '',
        'suspend fun load(): List<String> = emptyList()',
        '',
        'open class BaseUser',
        '',
        'class UserService {',
        '}',
      ]),
    ).toEqual([
      'class User',
      'class Result',
      'object AppConfig',
      'interface Repository',
      'fun main',
      'fun load',
      'class BaseUser',
      'class UserService',
    ]);
  });

  it('Go: func, receiver methods, generic func and type declarations', () => {
    expect(
      decls('main.go', [
        'package main',
        '',
        'import "fmt"',
        '',
        'type Server struct {',
        '\tPort int',
        '}',
        '',
        'type Handler interface {',
        '\tHandle() error',
        '}',
        '',
        'func NewServer(port int) *Server {',
        '\treturn &Server{Port: port}',
        '}',
        '',
        'func (s *Server) Start() error {',
        '\treturn nil',
        '}',
        '',
        'func Map[T any](in []T) []T {',
        '\treturn in',
        '}',
        '',
        'func main() {',
        '\tfmt.Println("hi")',
        '}',
      ]),
    ).toEqual([
      'type Server',
      'type Handler',
      'func NewServer',
      'func Start',
      'func Map',
      'func main',
    ]);
  });

  it('Rust: pub fn, unsafe fn, struct, enum, trait, impl, mod and type', () => {
    expect(
      decls('src/lib.rs', [
        'use std::collections::HashMap;',
        '',
        'pub struct Config {',
        '    pub port: u16,',
        '}',
        '',
        'pub enum Mode {',
        '    Fast,',
        '}',
        '',
        'pub trait Handler {',
        '    fn handle(&self);',
        '}',
        '',
        'impl Handler for Config {',
        '    fn handle(&self) {}',
        '}',
        '',
        'pub fn run(config: Config) -> Result<(), String> {',
        '    Ok(())',
        '}',
        '',
        'fn helper() {}',
        '',
        'pub unsafe fn dangerous() {}',
        '',
        'mod utils;',
        '',
        'type Alias = HashMap<String, u16>;',
      ]),
    ).toEqual([
      'struct Config',
      'enum Mode',
      'trait Handler',
      'impl Handler',
      'fn run',
      'fn helper',
      'fn dangerous',
      'mod utils',
      'type Alias',
    ]);
  });

  it('C: struct, enum, union, typedef struct and return-type functions', () => {
    expect(
      decls('src/main.c', [
        '#include <stdio.h>',
        '',
        'struct Point {',
        '    int x;',
        '    int y;',
        '};',
        '',
        'enum Mode { FAST, SLOW };',
        '',
        'union Value {',
        '    int i;',
        '    float f;',
        '};',
        '',
        'typedef struct Node {',
        '    struct Node *next;',
        '} Node;',
        '',
        'int main(int argc, char **argv) {',
        '    return 0;',
        '}',
        '',
        'void parse(const char *input) {',
        '}',
        '',
        'static bool ready(void) {',
        '    return true;',
        '}',
      ]),
    ).toEqual([
      'struct Point',
      'enum Mode',
      'union Value',
      'struct Node',
      'function main',
      'function parse',
      'function ready',
    ]);
  });

  it('C++: nested namespace, class, enum class and free functions', () => {
    expect(
      decls('src/widget.cpp', [
        '#include <string>',
        '',
        'namespace app::ui;',
        '',
        'class Widget {',
        'public:',
        '    explicit Widget(int id);',
        '};',
        '',
        'enum class Color { Red, Green };',
        '',
        'int add(int a, int b) { return a + b; }',
        '',
        'std::string name(void) { return "x"; }',
      ]),
    ).toEqual(['namespace app::ui', 'class Widget', 'enum Color', 'function add', 'function name']);
  });
});

describe('symbols — negative edge cases', () => {
  it('control flow and assignments are never read as declarations', () => {
    expect(
      decls('src/flow.c', [
        'if (ready) { start(); }',
        'else if (other) { stop(); }',
        'while (running) { tick(); }',
        'for (i = 0; i < n; i++) { }',
        'return compute(1);',
        'const x = 5;',
        'Foo bar = make();',
        'value = compute(1);',
        'result.push(item);',
        'print("class Fake");',
      ]),
    ).toEqual([]);
  });

  it('comment and string bodies do not produce declarations', () => {
    expect(
      decls('src/noise.ts', [
        '// public class Fake',
        '# def fake',
        '* class Doc',
        '-- function fake',
        '/* class Block */',
        '"class Quoted"',
      ]),
    ).toEqual([]);
  });

  it('indented members stay out of the index (top-level contract), column 0 does not', () => {
    expect(
      decls('src/Indented.java', [
        '    public void login() {}',
        '\tfunc helper() {}',
        '        def inner():',
      ]),
    ).toEqual([]);
    // positive control: the identical signature at column 0 is detected
    expect(decls('src/TopLevel.java', ['public void login() {}'])).toEqual(['function login']);
  });

  it('the kind list is duplicate-free and covers every advertised keyword', () => {
    expect(new Set(DECLARATION_KINDS).size).toBe(DECLARATION_KINDS.length);
    for (const kind of ['func', 'fn', 'fun', 'mod', 'union', 'record', 'object', 'namespace', 'module']) {
      expect(DECLARATION_KINDS).toContain(kind);
    }
  });
});

describe('symbols — engine integration', () => {
  let workspace: string;
  let repoDir: string;
  let engine: Engine;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aegisx-symbols-'));
    repoDir = path.join(workspace, 'repo');
    fs.mkdirSync(repoDir);
    engine = new Engine(path.join(workspace, 'memory.sqlite'));
  });

  afterEach(() => {
    engine.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('a Go func reaches both the structure brief and query-less recall', () => {
    fs.writeFileSync(
      path.join(repoDir, 'main.go'),
      ['package main', '', 'func Serve() error {', '  return nil', '}', ''].join('\n'),
    );
    engine.indexRepo(repoDir);

    const result = engine.recall(null, repoDir);
    expect(result.brief).toContain('### Key symbols');
    expect(result.brief).toContain('func Serve');
    expect(result.symbols.some((s) => s.kind === 'func' && s.name === 'Serve')).toBe(true);
  });
});

from os import path
from setuptools import Extension, setup
from setuptools.command.build import build
from setuptools.command.build_ext import build_ext
from wheel.bdist_wheel import bdist_wheel

HERE = path.abspath(path.dirname(__file__))
with open(path.join(HERE, "README.md"), encoding="utf-8") as f:
    LONG_DESCRIPTION = f.read()

class Build(build):
    def run(self):
        if path.isdir("queries"):
            dest = path.join(self.build_lib, "tree_sitter_clean", "queries")
            self.copy_tree("queries", dest)
        super().run()

class BuildExt(build_ext):
    def build_extension(self, ext):
        if self.compiler.compiler_type != "msvc":
            ext.extra_compile_args = ["-std=c11", "-fvisibility=hidden"]
        else:
            ext.extra_compile_args = ["/std:c11", "/utf-8"]
        if path.exists("src/scanner.c"):
            ext.sources.append("src/scanner.c")
        super().build_extension(ext)

class BdistWheel(bdist_wheel):
    def get_tag(self):
        python, abi, platform = super().get_tag()
        if python.startswith("cp"):
            python, abi = "cp310", "abi3"
        # PyPI rejects the raw `linux_x86_64` platform tag — wheels must be
        # manylinux-tagged. The GitHub Actions ubuntu-24.04 runner ships
        # glibc 2.39, so claim the highest manylinux floor that the build
        # actually satisfies (a lower floor would break on older glibc).
        if platform == "linux_x86_64":
            platform = "manylinux_2_39_x86_64"
        return python, abi, platform

setup(
    name="tree-sitter-clean",
    version="1.2.5",
    description="Clean grammar for tree-sitter",
    long_description=LONG_DESCRIPTION,
    long_description_content_type="text/markdown",
    author="Muhammad Ishaq Khan",
    author_email="ishaq2321@users.noreply.github.com",
    url="https://github.com/ishaq2321/tree-sitter-clean",
    license="MIT",
    classifiers=[
        "Development Status :: 5 - Production/Stable",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: MIT License",
        "Programming Language :: C",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
        "Topic :: Software Development :: Compilers",
        "Topic :: Text Processing :: Linguistic",
    ],
    python_requires=">=3.10",
    packages=["tree_sitter_clean"],
    package_dir={"": "bindings/python"},
    package_data={
        "tree_sitter_clean": ["*.pyi", "py.typed"],
        "tree_sitter_clean.queries": ["*.scm"],
    },
    ext_package="tree_sitter_clean",
    ext_modules=[
        Extension(
            name="_binding",
            sources=[
                "bindings/python/tree_sitter_clean/binding.c",
                "src/parser.c",
            ],
            define_macros=[
                ("PY_SSIZE_T_CLEAN", None),
                ("TREE_SITTER_HIDE_SYMBOLS", None),
            ],
            include_dirs=["src"],
        )
    ],
    cmdclass={
        "build": Build,
        "build_ext": BuildExt,
        "bdist_wheel": BdistWheel,
    },
    zip_safe=False,
)

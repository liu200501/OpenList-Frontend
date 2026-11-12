#!/bin/bash

set -e

# Colors for logging
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Logging functions
log_info() { echo -e "${CYAN}$1${NC}"; }
log_success() { echo -e "${GREEN}✓ $1${NC}"; }
log_error() { echo -e "${RED}✗ Error: $1${NC}"; }
log_warning() { echo -e "${YELLOW}$1${NC}"; }
log_step() { echo -e "${PURPLE}$1${NC}"; }
log_build() { echo -e "${BLUE}$1${NC}"; }

# Main function to run the build script
main() {
    parse_args "$@"
    set_defaults
    check_git_version_and_commit
    set_build_version
    if [[ "$LITE_FLAG" == "true" ]]; then
        archive_name="openlist-frontend-dist-lite-${version_tag}"
    else
        archive_name="openlist-frontend-dist-${version_tag}"
    fi
    build_project
    create_version_file
    handle_compression
    log_success "Build completed."
}

# Parse command-line arguments
parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --dev) BUILD_TYPE="dev"; shift ;;
            --release) BUILD_TYPE="release"; shift ;;
            --compress) COMPRESS_FLAG="true"; shift ;;
            --no-compress) COMPRESS_FLAG="false"; shift ;;
            --enforce-tag) ENFORCE_TAG="true"; shift ;;
            --skip-i18n) SKIP_I18N="true"; shift ;;
            --lite) LITE_FLAG="true"; shift ;;
            -h|--help) display_help; exit 0 ;;
            *) log_error "Unknown option: $1"; display_help; exit 1 ;;
        esac
    done
}

# Display help message
display_help() {
    echo "Usage: $0 [--dev|--release] [--compress|--no-compress] [--enforce-tag] [--skip-i18n] [--lite]"
    echo ""
    echo "Options (will overwrite environment setting):"
    echo "  --dev         Build development version"
    echo "  --release     Build release version (will check if git tag match package.json version)"
    echo "  --compress    Create compressed archive"
    echo "  --no-compress Skip compression"
    echo "  --enforce-tag Force git tag requirement for both dev and release builds"
    echo "  --skip-i18n   Skip i18n generation step (uses existing src/lang as-is)"
    echo "  --lite        Build lite version"
    echo ""
    echo "Environment variables:"
    echo "  OPENLIST_FRONTEND_BUILD_MODE=dev|release (default: dev)"
    echo "  OPENLIST_FRONTEND_BUILD_COMPRESS=true|false (default: false)"
    echo "  OPENLIST_FRONTEND_BUILD_ENFORCE_TAG=true|false (default: false)"
    echo "  OPENLIST_FRONTEND_BUILD_SKIP_I18N=true|false (default: false)"
}

# Set default values from environment variables
set_defaults() {
    BUILD_TYPE=${BUILD_TYPE:-${OPENLIST_FRONTEND_BUILD_MODE:-dev}}
    COMPRESS_FLAG=${COMPRESS_FLAG:-${OPENLIST_FRONTEND_BUILD_COMPRESS:-false}}
    ENFORCE_TAG=${ENFORCE_TAG:-${OPENLIST_FRONTEND_BUILD_ENFORCE_TAG:-false}}
    SKIP_I18N=${SKIP_I18N:-${OPENLIST_FRONTEND_BUILD_SKIP_I18N:-false}}
    LITE_FLAG=${LITE_FLAG:-false}
}

# Check git version and commit
check_git_version_and_commit() {
    if [[ "$BUILD_TYPE" == "release" || "$ENFORCE_TAG" == "true" ]]; then
        enforce_git_tag
    else
        fallback_git_tag
    fi
    commit=$(git rev-parse --short HEAD)
}

# Enforce git tag for release builds
enforce_git_tag() {
    if ! git_version=$(git describe --abbrev=0 --tags 2>/dev/null); then
        log_error "No git tags found. Release build requires a git tag."
        log_warning "Please create a tag first, or use --dev for development builds."
        exit 1
    fi
    validate_git_tag
}

# Validate git tag against package.json version
validate_git_tag() {
    package_version=$(node -p 'require("./package.json").version')
    git_version_clean=${git_version#v}
    if [[ "$git_version_clean" != "$package_version" ]]; then
        log_error "Package.json version (${package_version}) does not match git tag (${git_version_clean})."
        exit 1
    fi
}

# Fallback to default git tag for development builds
fallback_git_tag() {
    if ! git_version=$(git describe --abbrev=0 --tags --match 'v[0-9]*.[0-9]*.[0-9]*' 2>/dev/null); then
        git_version_clean=$(node -p 'require("./package.json").version')
        return
    fi

    git_version_clean=${git_version#v}
    if [[ "$git_version_clean" =~ ^([0-9]+\.[0-9]+\.[0-9]+)([-+][0-9A-Za-z.-]+)?$ ]]; then
        git_version_clean=${BASH_REMATCH[1]}
    else
        git_version_clean=$(node -p 'require("./package.json").version')
    fi
}

# Set the version for the build
set_build_version() {
    if [[ "$BUILD_TYPE" == "dev" ]]; then
        log_info "Using ${git_version_clean} as the development build version"
        version_tag="v${git_version_clean}-${commit}"
        log_build "Building DEV version ${version_tag}..."
    elif [[ "$BUILD_TYPE" == "release" ]]; then
        version_tag="v${git_version_clean}"
        log_build "Building RELEASE version ${version_tag}..."
    else
        log_error "Invalid build type: $BUILD_TYPE. Use --dev or --release."
        exit 1
    fi
}

# Build the project
build_project() {
    log_step "==== Installing dependencies ===="
    pnpm install

    log_step "==== Building i18n ===="
    # 使用本地 src/lang 下的 JSON 作为翻译源，直接生成 entry.ts 并补齐缺失语言文件。
    # 不再调用 Crowdin，也不再从 GitHub Release 下载 i18n.tar.gz 覆盖源码。
    # 校验永远执行：--skip-i18n 只跳过生成，不允许跳过检查
    log_info "Checking i18n dictionaries..."
    node ./scripts/check-i18n.mjs
    if [[ "$SKIP_I18N" == "true" ]]; then
        log_info "--skip-i18n: 使用现有 src/lang，跳过 entry.ts 生成"
    else
        log_info "Running i18n build script to generate entry.ts..."
        node ./scripts/i18n.mjs
    fi

    log_step "==== Building project ===="
    if [[ "$LITE_FLAG" == "true" ]]; then
        pnpm build:lite
    else
        pnpm build
    fi
}

# Create VERSION file in the dist directory
create_version_file() {
    log_step "Writing version $version_tag to dist/VERSION..."
    echo -n "$version_tag" > dist/VERSION
    log_success "Version file created: dist/VERSION"
}

# Handle compression if requested
handle_compression() {
    if [[ "$COMPRESS_FLAG" == "true" ]]; then
        log_step "Creating compressed archive..."
        tar -czvf "${archive_name}.tar.gz" -C dist .
        tar -czvf "i18n.tar.gz" --exclude=en -C src/lang .
        mv "${archive_name}.tar.gz" dist/
        mv "i18n.tar.gz" dist/
        log_success "Compressed archive created: dist/${archive_name}.tar.gz dist/i18n.tar.gz"
    fi
}

# Run the script
main "$@"
